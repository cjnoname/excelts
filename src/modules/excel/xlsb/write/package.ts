/**
 * Assemble an XLSB package.
 *
 * The binary parts come from `workbook.ts`, `worksheet.ts` and `shared-strings.ts`; everything else in
 * the package is XML and is exactly the same XML an XLSX has. The relationship and content-type
 * writers are therefore reused rather than reimplemented — OPC is not the part of this that is
 * specific to XLSB, and a second relationships writer would be a second place for the same bug.
 *
 * What *is* specific: the workbook part is `xl/workbook.bin`, and its content type
 * declares a binary workbook. Getting that pair wrong is the fastest way to a package
 * Excel refuses, which is why `check-package.ts` looks at exactly those two things.
 *
 * This module owns the decisions that need to see the whole package at once, and each of them was a
 * bug first: what a drawing or a medium may be *named* (a preserved part may already hold the name),
 * which relationship ids are free (a preserved relationship may already hold `rId1`), and which
 * extensions this writer declares itself (a preserved part relying on a conflicting `Default` needs an
 * `Override`). None of those questions can be answered by a part writer looking at one sheet.
 */

import {
  imageContentTypeFor,
  isForeignSheetPart,
  isRootOrWorkbookSourced
} from "@excel/core/opaque-part";
import type {
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/core/opaque-part";
import type { PivotTable } from "@excel/core/pivot-table";
import { sheetsInTabOrder } from "@excel/core/sheet-order";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import { STREAMED_LEGACY_VML_REL_ID } from "@excel/stream/xlsb-writer";
import type { IgnoredError } from "@excel/types";
import { decodeCell } from "@excel/utils/address";
import {
  buildDrawingAnchorsAndRels,
  buildWatermarkOverlayAnchors,
  buildChartAnchors,
  buildFormControlAnchors,
  buildShapeAnchors,
  isExternalImage,
  type DrawingAnchor,
  type DrawingRel,
  type ImageMedium,
  type ChartAnchorLike,
  type FormControlLike,
  type MediaLike,
  type ShapeLike
} from "@excel/utils/drawing-utils";
import {
  drawingPath,
  drawingRelTargetFromWorksheet,
  drawingRelsPath,
  mediaPath,
  themePath
} from "@excel/utils/ooxml-paths";
import type { PackageSink } from "@excel/utils/package-sink";
import { ArchiveSink } from "@excel/utils/package-sink-adapters";
import { encodeBiffRecords } from "@excel/xlsb/binary";
import { encodeChartsheetPart } from "@excel/xlsb/chartsheet";
import { encodeCommentsPart } from "@excel/xlsb/comments";
import { collectDxfs, type SheetConditionalFormatting } from "@excel/xlsb/conditional-format";
import type {
  BookProtectionLike,
  SheetProtectionLike,
  WorkbookViewLike
} from "@excel/xlsb/defaults";
import { futureFunctionStubName, isFutureFunction } from "@excel/xlsb/formula/ptg";
import {
  pivotCacheDefinitionRecords,
  pivotCacheRecordsRecords,
  type PivotCacheModel
} from "@excel/xlsb/pivot-cache";
import { pivotParts } from "@excel/xlsb/pivot-model";
import { pivotViewRecords, type PivotViewModel } from "@excel/xlsb/pivot-view";
import type { PivotCacheBinding } from "@excel/xlsb/read/parts";
import type { SheetSparklineGroup } from "@excel/xlsb/sparkline";
import { CellFormatTable, internStyle, writeStyles, type NamedStyleLike } from "@excel/xlsb/styles";
import { encodeTablePart } from "@excel/xlsb/tables";
import { record } from "@excel/xlsb/write/emit";
import { workbookLosses, worksheetLosses } from "@excel/xlsb/write/losses";
import {
  breaksFromModel,
  columnsFromModel,
  sheetOptionsFromModel,
  commentsFromModel,
  tablesFromModel,
  hyperlinksFromModel,
  pivotAnchorsFromModel,
  paneFromModel,
  printNamesFromModel,
  validationsFromModel,
  viewSettingsFromModel,
  mergesFromModel,
  sheetRowsFromModel
} from "@excel/xlsb/write/model-adapter";
import { SharedStringTable, writeSharedStrings } from "@excel/xlsb/write/shared-strings";
import { writeWorkbookPart } from "@excel/xlsb/write/workbook";
import { writeWorksheetPart } from "@excel/xlsb/write/worksheet";
import {
  appendOpaqueSourceRelationships,
  opaqueContentTypeDeclarations,
  relationshipsPathFor,
  relationshipStillResolves,
  resolveReachableOpaqueParts
} from "@excel/xlsx/opaque-parts";
import { RelType } from "@excel/xlsx/rel-type";
import { ChartSpaceXform } from "@excel/xlsx/xform/chart/chart-space-xform";
import {
  renderPersonList,
  renderThreadedComments
} from "@excel/xlsx/xform/comment/threaded-comments-xform";
import { AppXform } from "@excel/xlsx/xform/core/app-xform";
import { CoreXform } from "@excel/xlsx/xform/core/core-xform";
import { RelationshipsXform } from "@excel/xlsx/xform/core/relationships-xform";
import { CtrlPropXform } from "@excel/xlsx/xform/drawing/ctrl-prop-xform";
import { VmlDrawingXform } from "@excel/xlsx/xform/drawing/vml-drawing-xform";
import type { ChartsheetModel } from "@excel/xlsx/xform/sheet/chartsheet-xform";
import {
  CHARTSHEET_DRAWING_EMU,
  renderChartWithLeadingComments,
  renderChartsheetDrawingXml,
  XLSX
} from "@excel/xlsx/xlsx.browser";
import { theme1Xml } from "@excel/xlsx/xml/theme1";
import { stringToUint8Array } from "@utils/binary";
import { readFileBytes } from "@utils/fs";
import { base64ToUint8Array } from "@utils/utils.base";
import { XmlWriter } from "@xml/writer";

/** Content type for a binary workbook part. */
const WORKBOOK_CONTENT_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.main";
const WORKSHEET_CONTENT_TYPE = "application/vnd.ms-excel.worksheet";
/** A chartsheet part's type, read off `cal-any_sheets.xlsb`. */
const CHARTSHEET_CONTENT_TYPE = "application/vnd.ms-excel.chartsheet";
/** The relationship a workbook uses to reach a chartsheet. */
const CHARTSHEET_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet";
/**
 * The comments part's own type.
 *
 * Read off `poi-comments.xlsb` rather than assumed: a comments part in an XLSB package is binary, so it
 * is `…ms-excel.comments` and not the XLSX `…spreadsheetml.comments+xml` that a search for "comments
 * content type" turns up.
 */
const COMMENTS_CONTENT_TYPE = "application/vnd.ms-excel.comments";
/** The table part's type, from MS-XLSB 2.1.7.51. */
const TABLE_CONTENT_TYPE = "application/vnd.ms-excel.table";

/**
 * The three `chartEx` part types, matched by path.
 *
 * **All lowercase.** Excel 2016+ compares these exactly and drops a `chartEx` whose declaration does not match,
 * which cascades into the parent drawing being removed. The XLSX writer notes the same thing at its own copy.
 */
const CHART_EX_CONTENT_TYPES: readonly { readonly test: RegExp; readonly type: string }[] = [
  { test: /chartEx\d+\.xml$/, type: "application/vnd.ms-office.chartex+xml" },
  { test: /styleEx\d+\.xml$/, type: "application/vnd.ms-office.chartstyle+xml" },
  { test: /colorsEx\d+\.xml$/, type: "application/vnd.ms-office.chartcolorstyle+xml" }
];

/** The `BrtPrintOptions` fields, named once so the copy loop and the record encoder cannot disagree. */
/** The three PivotCache and PivotTable content types. All `.bin`, all needing an `Override`. */
const PIVOT_TABLE_CONTENT_TYPE = "application/vnd.ms-excel.pivotTable";
const PIVOT_CACHE_DEFINITION_CONTENT_TYPE = "application/vnd.ms-excel.pivotCacheDefinition";
const PIVOT_CACHE_RECORDS_CONTENT_TYPE = "application/vnd.ms-excel.pivotCacheRecords";
const SHARED_STRINGS_CONTENT_TYPE = "application/vnd.ms-excel.sharedStrings";
const STYLES_CONTENT_TYPE = "application/vnd.ms-excel.styles";

const OFFICE_DOCUMENT_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const WORKSHEET_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const SHARED_STRINGS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";
const STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

export interface XlsbWriteResult {
  readonly bytes: Uint8Array;
  /**
   * Cell values that could not be expressed, as addresses.
   *
   * Returned rather than thrown or ignored: this writer covers strings, numbers,
   * booleans, dates and blanks, and a caller handed a formula needs to know it was
   * dropped. Silently omitting them is the failure mode that makes a converter
   * untrustworthy; failing outright would make the writer unusable before formulas
   * exist.
   */
  readonly unsupported: readonly string[];
}

/**
 * What a caller may hand this writer besides the model.
 *
 * `streamed` is present for exactly one caller — `Stream.WorkbookWriter` with `format: "xlsb"` — and every field
 * in it exists because that caller has already done part of the work. It is stated as a claim the caller makes
 * rather than inferred from the sink's contents: "these paths are in the sink, and these tables are what their
 * records index into". Inferring it (skipping any path the sink already has) would work today and silently
 * swallow a genuine double-write tomorrow.
 */
export interface XlsbWriteOptions {
  /**
   * Where the parts go. Omitted means "assemble a buffer and return it", which is what every caller has always
   * asked for; supplying one is how a streaming destination gets the same parts without a second writer.
   */
  readonly sink?: PackageSink;
  /** Work a streaming caller has already done. Omitted means "none of it". */
  readonly streamed?: {
    /** Sheet part paths already in the sink. This writer will not produce them again. */
    readonly sheetPaths: ReadonlySet<string>;
    /** The table the already-written `BrtCellIsst` indices point into. */
    readonly strings: SharedStringTable;
    /** The table the already-written `ixfe` values point into. */
    readonly formats: CellFormatTable;
  };
}

export async function writeXlsbPackage(
  model: WorkbookModel,
  options?: XlsbWriteOptions
): Promise<XlsbWriteResult> {
  // **The interning tables may come from the caller.** A streaming writer has already encoded its rows — that is
  // what makes it streaming — and every `BrtCellIsst` index and `ixfe` it emitted points into *its* tables. So
  // `sharedStrings.bin` and `styles.bin` have to be serialised from those, not from empty ones. Supplied rather
  // than returned because the tables are filled in as rows arrive, long before this function is called.
  const strings = options?.streamed?.strings ?? new SharedStringTable();
  const formats = options?.streamed?.formats ?? new CellFormatTable();
  const alreadyWritten = options?.streamed?.sheetPaths ?? new Set<string>();
  const unsupported: string[] = [];

  const worksheets = model.worksheets ?? [];
  // Chartsheets, read here rather than beside the parts they become, because the **tab order** below needs them and
  // that order has to be settled before a single formula is encoded. See `tabOrderNames`.
  //
  // **`model.chartsheets` is typed; this used to re-declare it.** The field was read through
  // `as unknown as { name?; chartNumber?; chartExNumber?; state?; orderNo? }[]` — a hand-written five-field shape
  // standing in for `ChartsheetModel`, which has thirty. The cast compiled, so nothing pointed at the gap, and the
  // fields it omitted could not be written even where the encoder already accepted them: `zoomToFit`, `zoomScale`,
  // `tabSelected`, `codeName` and `pageMargins` all reached this function and stopped here. `financial-report`'s
  // "Board View" opened blank in XLSB for that reason — a chartsheet has no cell grid, so `zoomToFit` is what sizes
  // the chart, and the same workbook's XLSX rendered it because that writer reads the model's real type.
  const chartsheets: readonly ChartsheetModel[] = model.chartsheets ?? [];
  /**
   * Every sheet's name in tab order — the order `BrtBundleSh` emits, which is what an `ixti` indexes.
   *
   * **This is the one sheet ordering in this writer, and there used to be two.** The formula context was built from
   * `worksheets` alone while the bundle was built with `sheetsInTabOrder`, so the two disagreed as soon as a chartsheet
   * sat anywhere but last. Measured on worksheet `A`, chartsheet `C`, worksheet `B`: `A!D1 = B!A1` was written with
   * `ixti` 1 — `B`'s position among the worksheets — and read back as `C!A1`, because position 1 in the bundle is the
   * chartsheet. A formula silently pointing at a different sheet is the worst kind of loss this module can produce, and
   * it opened cleanly.
   *
   * A chartsheet has no cells, so no formula can legitimately reference one; it is here to occupy its ordinal, which is
   * exactly what makes the following worksheets' ordinals correct.
   */
  const tabOrder = sheetsInTabOrder<{
    readonly name: string;
    readonly orderNo?: number;
    readonly sheetNo?: number;
    readonly kind: "worksheet" | "chartsheet";
    readonly at: number;
  }>(
    worksheets.map((worksheet, index) => ({
      name: worksheet.name ?? `Sheet${index + 1}`,
      orderNo: (worksheet as { orderNo?: number }).orderNo,
      sheetNo: index + 1,
      kind: "worksheet" as const satisfies "worksheet" | "chartsheet",
      at: index
    })),
    chartsheets.map((chartsheet, index) => ({
      name: chartsheet.name ?? `Chart${index + 1}`,
      orderNo: chartsheet.orderNo,
      sheetNo: index + 1,
      kind: "chartsheet" as const satisfies "worksheet" | "chartsheet",
      at: index
    }))
  );
  const tabOrderNames = tabOrder.map(entry => entry.name);
  /**
   * A worksheet's index in `model.worksheets` → its position on the tab bar.
   *
   * Two things read this, and both were using the worksheet index directly: `localSheetId` on a `_xlnm.*` print name,
   * which scopes it to a sheet by *bundle* ordinal, and the `fSelected` flag that has to agree with
   * `BrtBookView.itabCur`. With worksheet `A`, chartsheet `C`, worksheet `B` the first gave `B`'s print area to the
   * chartsheet, and the second matched no sheet at all — `itabCur` was 2 while the only candidate index was 1, so the
   * workbook opened with nothing selected.
   */
  const tabPositionByWorksheet = new Map<number, number>();
  tabOrder.forEach((entry, position) => {
    if (entry.kind === "worksheet") {
      tabPositionByWorksheet.set(entry.at, position);
    }
  });
  const tabPositionOf = (index: number): number => tabPositionByWorksheet.get(index) ?? index;
  // Read once and threaded through, because both the workbook part and every date serial depend
  // on it. A mismatch between the two would produce a file whose declared epoch disagrees with
  // its own numbers.
  const date1904 = model.properties?.date1904 === true;
  /** Drawing parts, accumulated as the sheets are visited and written afterwards. */
  const drawings: DrawingPart[] = [];

  // Paths preserved parts already occupy. Consulted before this writer names a drawing or a medium,
  // because a name that collides with a preserved part produces two entries for one path.
  const reservedPaths = new Set((model.opaqueParts ?? []).map(part => part.path.toLowerCase()));
  // Images: resolved once, before anything references them, and without touching the caller's model.
  const media = await planMedia(model, reservedPaths);
  unsupported.push(...media.losses);
  /** Collected per sheet, then qualified with the sheet name alongside the other sheet-level losses. */
  const drawingLosses: string[] = [];
  // Formulas name sheets and defined names by index, so the context has to be built before
  // any worksheet is serialised — a formula in sheet 1 may reference sheet 3.
  // Print areas and print titles are `_xlnm.*` defined names, not records, so they join the list before
  // the formula context is built from it — `PtgName` is a one-based index into this order, and appending
  // them afterwards would shift every index a formula already resolved.
  const definedNames = [
    ...(model.definedNames ?? []),
    ...printNamesFromModel(model.worksheets, tabPositionOf),
    // Stubs for functions the `Ftab` has no id for. Appended *here*, before the formula context is built,
    // because `PtgName` is a one-based index into this list and a name discovered while a formula was being
    // encoded would arrive after the index had been taken. See `futureFunctionStubs`.
    ...futureFunctionStubs(model.worksheets, [
      ...(model.definedNames ?? []),
      ...printNamesFromModel(model.worksheets, tabPositionOf)
    ])
  ];
  // Tables, by name, so a structured reference can resolve to an `idList` and a column index. Built
  // *before* the formula context because `PtgList` needs it while a cell formula is being encoded — and
  // the ids are assigned here rather than in the sheet loop for the same reason, since a formula on
  // sheet 1 may reference a table on sheet 3.
  const tableIds = new Map<string, { id: number; columns: readonly string[]; sheet: string }>();
  worksheets.forEach((worksheet, index) => {
    for (const table of tablesFromModel(worksheet)) {
      if (!tableIds.has(table.name)) {
        tableIds.set(table.name, {
          id: tableIds.size + 1,
          columns: table.columns.map(column => column.name),
          // `PtgList` carries an `ixti`, so the encoder needs the table's *sheet* as well as its id. The
          // name is spelled the same way `sheetNames` below spells it, because the encoder resolves the
          // two against each other — a table recorded as `Sheet3` while the list says `undefined` would
          // fail to resolve rather than resolve wrongly, but only by luck.
          sheet: worksheet.name ?? `Sheet${index + 1}`
        });
      }
    }
  });

  const formulaContext = {
    tables: tableIds,
    // In tab order, not worksheet order — see `tabOrderNames`.
    sheetNames: tabOrderNames,
    definedNames: definedNames.map(defined => defined.name),
    // The identity table `writeWorkbookPart` emits. Stated here rather than left implicit so the
    // encoder resolves an `ixti` against the same table the file will carry — if the two ever
    // disagree, every 3D reference in the output points at the wrong sheet.
    //
    // **Mutable on purpose.** A reference across a span of sheets has no identity entry, so the encoder
    // appends one; the worksheets are serialised before the workbook part, so an entry added while a
    // formula is being encoded still reaches the file. Freezing this would mean narrowing such a
    // reference to its first sheet, which is what it used to do.
    externSheets: tabOrderNames.map((_name, index) => ({ first: index, last: index }))
  };

  // ctrlProp part numbers are workbook-wide for the same reason table ids are.
  let ctrlPropCount = 0;
  // The differential-format table a rule's `dxfId` indexes. Built across *every* sheet before any of them
  // is written, because the index is workbook-wide — a per-sheet table would give two sheets' rules the
  // same id for different formatting.
  const dxfIndex = collectDxfs(
    worksheets.flatMap(
      worksheet =>
        (worksheet as unknown as { conditionalFormattings?: readonly SheetConditionalFormatting[] })
          .conditionalFormattings ?? []
    )
  );
  // `iPri` "MUST NOT duplicate" another rule's anywhere in the sheet. The model's priorities are per block and
  // routinely collide, so they cannot simply be copied — but they also cannot simply be replaced, which is what
  // a running counter did: Excel keeps the numbers a file states, and comparing this library's output against
  // an XLSB Excel wrote for the same workbook showed every rule renumbered.
  //
  // So a stated priority is honoured when it is a positive integer nobody has claimed, and the counter fills in
  // for the rest. `claimed` is workbook-wide, which is stricter than the record requires and costs nothing.
  const claimed = new Set<number>();
  let cfPriority = 0;
  const nextCfPriority = (stated: number | undefined): number => {
    if (stated !== undefined && Number.isInteger(stated) && stated > 0 && !claimed.has(stated)) {
      claimed.add(stated);
      return stated;
    }
    do {
      cfPriority += 1;
    } while (claimed.has(cfPriority));
    claimed.add(cfPriority);
    return cfPriority;
  };
  // `BrtBeginList.idList` must be unique across the whole workbook and at least 1, so it is counted here
  // rather than derived from a sheet's own column index — two sheets each with one table would otherwise
  // Which sheet Excel highlights on open. `BrtBookView.itabCur` says it for the workbook; the sheet's own
  // `BrtBeginWsView` has to agree with `fSelected`, and Excel sets both.
  const activeSheetIndex = Math.max(
    0,
    Math.trunc(
      (model as unknown as { views?: readonly { activeTab?: number }[] }).views?.[0]?.activeTab ?? 0
    )
  );
  /**
   * The path of the chartsheet a sheet stands in for, or `undefined` for an ordinary sheet.
   *
   * **One reader, because three places asked and one of them was missed.** A chartsheet the XLSB reader cannot model is
   * kept as an empty worksheet carrying the path of the part it really is; the writer then must not give that placeholder
   * a sheet part, must point its relationship at the preserved chartsheet, *and* must not declare a content type for the
   * part it did not write. The third was overlooked, leaving `[Content_Types].xml` declaring
   * `xl/worksheets/sheet2.bin` — a name no ZIP entry answers to, which a strict OPC consumer is entitled to call damage.
   */
  const placeholderFor = (index: number): string | undefined =>
    (worksheets[index] as { chartsheetPlaceholder?: string } | undefined)?.chartsheetPlaceholder;

  const sheetParts = worksheets.map((worksheet, index) => {
    const sheetName = worksheet.name ?? `sheet${index + 1}`;
    // Images. The drawing part and the media are XML and bytes respectively, both shared with the
    // XLSX path; the only binary part is a `BrtDrawing` naming the relationship. Built before the
    // sheet is serialised because the record has to go inside it.
    const drawing = drawingForWorksheet(
      worksheet,
      media.named,
      index,
      drawings,
      reservedPaths,
      media.usable,
      drawingLosses
    );
    const merges = mergesFromModel(worksheet);
    const pane = paneFromModel(worksheet);
    // Compared on the *tab* position, because `BrtBookView.itabCur` is a bundle ordinal — see `tabPositionOf`.
    const viewSettings = viewSettingsFromModel(
      worksheet,
      tabPositionOf(index) === activeSheetIndex
    );
    // Both are read straight off the model: an auto filter is a range string and an ignored-error entry
    // already carries its own range, so neither needs an adapter.
    const sheet = worksheet as unknown as {
      autoFilter?: string;
      autoFilterCriteria?: { readonly xml?: string };
      ignoredErrors?: readonly IgnoredError[];
      sparklineGroups?: readonly SheetSparklineGroup[];
      conditionalFormattings?: readonly SheetConditionalFormatting[];
    };
    const validations = validationsFromModel(worksheet);
    const breaks = breaksFromModel(worksheet);
    // Hyperlinks. The destination is an OPC relationship rather than anything in the record stream, so
    // the ids are allocated here — alongside the drawing's, and past whatever a preserved relationship
    // already occupies — and the `.rels` entries are written with the sheet below.
    const takenIds = new Set([
      ...(worksheet.opaqueRels ?? []).map(relationship => relationship.id),
      ...(drawing === undefined ? [] : [drawing.rId])
    ]);
    // Comments need two relationships and one of them is named by a record, so both ids are allocated
    // here alongside the drawing's and the hyperlinks'. The VML is what `BrtLegacyDrawing` points at;
    // the comments part itself is reached implicitly and is *not* named by any record, which
    // `poi-comments.xlsb` confirms — its `rId3` targets `../comments1.bin` and nothing refers to it.
    // Tables. `idList` must be unique across the *workbook*, so the id comes from a counter outside this
    // per-sheet mapping rather than from the sheet's own index.
    const tables = tablesFromModel(worksheet).map(table => {
      const relationshipId = unusedName(
        candidate => takenIds.has(candidate),
        base => `rId${base}`,
        1
      );
      takenIds.add(relationshipId);
      // The id from the pass above, so a `PtgList` and its `BrtBeginList` agree. Counting again here
      // produced the same numbers by luck and would have diverged the moment two sheets shared a table
      // name or a table failed to encode.
      return { ...table, id: tableIds.get(table.name)?.id ?? 0, relationshipId };
    });
    // Media that is not a placed picture. Each reaches the sheet a different way: a background is one
    // relationship plus `BrtBkHim`, and a header picture lives in the header/footer VML that
    // `BrtLegacyDrawingHF` points at.
    //
    // An *overlay* watermark is none of those — it is a picture in the sheet's own drawing, stretched over
    // the data area with an alpha, and it is handled with the other drawing media in
    // `drawingForWorksheet`. It used to be collected here, which put it in the header VML: the picture
    // came back as a `headerImage` in the centre of the page header with its opacity dropped. Nothing
    // caught that, because the result was a valid workbook — just not the one that was written.
    const otherMedia = (worksheet.media ?? []).filter(
      medium =>
        (medium.type === "background" || medium.type === "headerImage") &&
        media.usable.has(Number(medium.imageId))
    );
    const background = otherMedia.find(medium => medium.type === "background");
    const headerImages = otherMedia.filter(medium => medium.type !== "background");
    const backgroundRel =
      background === undefined
        ? undefined
        : (() => {
            const id = unusedName(
              candidate => takenIds.has(candidate),
              base => `rId${base}`,
              1
            );
            takenIds.add(id);
            return id;
          })();
    const headerFooterRel =
      headerImages.length === 0
        ? undefined
        : (() => {
            const id = unusedName(
              candidate => takenIds.has(candidate),
              base => `rId${base}`,
              1
            );
            takenIds.add(id);
            return id;
          })();
    // Threaded comments: read straight off the model, because the part is XML and identical in both
    // containers — nothing here has to be translated into records.
    const threadedComments = (worksheet as unknown as { threadedComments?: readonly unknown[] })
      .threadedComments;
    const threadedCommentRel =
      threadedComments === undefined || threadedComments.length === 0
        ? undefined
        : (() => {
            const id = unusedName(
              candidate => takenIds.has(candidate),
              base => `rId${base}`,
              1
            );
            takenIds.add(id);
            return id;
          })();
    // Form controls. Three parts each in effect: the hidden DrawingML anchor (added by
    // `drawingForWorksheet` above), a VML shape that draws the control, and an `xl/ctrlProps/ctrlPropN.xml`
    // holding its properties — reached by its own relationship. Omitting any one leaves a control Excel
    // offers to repair.
    const formControls = (
      (worksheet as unknown as { formControls?: readonly FormControlLike[] }).formControls ?? []
    ).filter(control => control.tl !== undefined && control.br !== undefined);
    const formControlRels = formControls.map(control => {
      const id = unusedName(
        candidate => takenIds.has(candidate),
        base => `rId${base}`,
        1
      );
      takenIds.add(id);
      // The ctrlProp part number is workbook-wide, like a table's — two sheets each with one control
      // would otherwise both write `ctrlProp1.xml`.
      const ctrlPropId = ++ctrlPropCount;
      return { control, relationshipId: id, ctrlPropId };
    });
    // Declared before the relationships below, because whether this sheet was streamed decides who owns its VML
    // relationship id — see `commentRels`.
    const streamedPath = `xl/worksheets/sheet${index + 1}.bin`;
    const wasStreamed = alreadyWritten.has(streamedPath);
    const comments = commentsFromModel(worksheet);
    const commentRels =
      comments.length === 0
        ? undefined
        : (() => {
            // **A streamed sheet has already named this id inside its own part, so it is honoured rather than
            // reallocated.** `BrtLegacyDrawing` sits inside the sheet, which was closed before this ran, and it names the
            // relationship reaching the VML that draws a note's marker. Allocating a fresh id here would leave that
            // record pointing at nothing — which is what happened while the streamed path emitted no record at all.
            //
            // Seeded into `takenIds` as well, so nothing else on the sheet can be given the same id.
            const vml =
              (wasStreamed ? STREAMED_LEGACY_VML_REL_ID : undefined) ??
              unusedName(
                candidate => takenIds.has(candidate),
                base => `rId${base}`,
                1
              );
            takenIds.add(vml);
            const part = unusedName(
              candidate => takenIds.has(candidate),
              base => `rId${base}`,
              1
            );
            takenIds.add(part);
            return { vml, part };
          })();
    const links = hyperlinksFromModel(worksheet).map(link => {
      // **An internal link gets no relationship.** Its destination is the `location` field of `BrtHLink`, and
      // allocating an id for it both wasted the id and, worse, produced a `.rels` entry declaring `#Linked!A1` as an
      // *external* target — a link that navigated nowhere. Excel writes an empty id for these.
      if (link.location !== undefined) {
        return { ...link, relationshipId: "" };
      }
      const relationshipId = unusedName(
        candidate => takenIds.has(candidate),
        base => `rId${base}`,
        1
      );
      takenIds.add(relationshipId);
      return { ...link, relationshipId };
    });
    // One VML file per sheet holds both a note's box and a control's shape, so one relationship reaches it
    // and `BrtLegacyDrawing` names that one. Allocated here rather than inside the comments branch,
    // because a sheet with controls and no comments needs it just as much — and without it the VML is
    // present with nothing pointing at it, which Excel offers to repair.
    const legacyVmlRel =
      commentRels?.vml ??
      (formControls.length === 0
        ? undefined
        : (() => {
            const id = unusedName(
              candidate => takenIds.has(candidate),
              base => `rId${base}`,
              1
            );
            takenIds.add(id);
            return id;
          })());
    // **A streamed sheet is not serialised again here.** Its bytes are in the sink and its strings and styles
    // are already interned; running the part writer over a model whose rows have been discarded would produce an
    // empty sheet, and the only reason it would be harmless is that the result is thrown away. Skipping it says
    // so, and keeps the interning tables from being touched twice.
    const written = alreadyWritten.has(streamedPath)
      ? { bytes: new Uint8Array(0), unsupported: [] as readonly string[] }
      : writeWorksheetPart({
          rows: sheetRowsFromModel(worksheet, date1904),
          // A pivot table occupies the grid without writing a cell there, so its anchor has to reach `BrtWsDim` or the
          // sheet is declared empty — which is what happened to all three pivot sheets in the oracle's `05-pivots`.
          occupiedRegions: pivotAnchorsFromModel(worksheet),
          strings,
          formulaContext,
          formats,
          merges: merges.ranges,
          columns: columnsFromModel(worksheet),
          ...sheetOptionsFromModel(worksheet),
          // A modelled drawing wins; otherwise the reference the sheet arrived with is re-emitted. That
          // second case is a read-modify-write of a workbook whose pictures this reader keeps as opaque
          // parts: the drawing XML and the media survive on their own, and this record is the only thing
          // connecting the sheet to them. Omitting it produced a package that passed every structural check
          // and opened in Excel with no pictures.
          ...drawingReference(worksheet, drawing),
          // The sheet has to name its table parts or Excel shows no table — see `tableRelationshipIds`. Only the
          // ones that will actually be written: a table that fails to encode has a relationship id allocated and
          // no part, and pointing at it would make the sheet reference a part the package does not contain.
          tableRelationshipIds: tables
            .filter(table => encodeTablePart(table) !== undefined)
            .map(table => table.relationshipId),
          hyperlinks: links,
          ...(pane === undefined ? {} : { pane }),
          ...(viewSettings === undefined ? {} : { viewSettings }),
          ...(sheet.autoFilter === undefined ? {} : { autoFilter: sheet.autoFilter }),
          ...(sheet.autoFilterCriteria?.xml === undefined
            ? {}
            : { autoFilterCriteriaXml: sheet.autoFilterCriteria.xml }),
          // The sheet's own name, which a sparkline's data formula has to be qualified with: the record
          // requires a `PtgArea3d`, and an unqualified range parses to a plain `PtgArea`.
          sheetName,
          ...(sheet.conditionalFormattings === undefined
            ? {}
            : { conditionalFormattings: sheet.conditionalFormattings }),
          dxfIndex,
          nextCfPriority,
          ...(sheet.sparklineGroups === undefined
            ? {}
            : { sparklineGroups: sheet.sparklineGroups }),
          ...(backgroundRel === undefined ? {} : { backgroundRelationshipId: backgroundRel }),
          ...(headerFooterRel === undefined
            ? {}
            : { headerFooterDrawingRelationshipId: headerFooterRel }),
          ...(sheet.ignoredErrors === undefined ? {} : { ignoredErrors: sheet.ignoredErrors }),
          ...((worksheet as unknown as { sheetProtection?: SheetProtectionLike })
            .sheetProtection === undefined
            ? {}
            : {
                sheetProtectionSettings: (
                  worksheet as unknown as { sheetProtection: SheetProtectionLike }
                ).sheetProtection
              }),
          ...(legacyVmlRel === undefined ? {} : { legacyDrawingRelationshipId: legacyVmlRel }),
          validations,
          rowBreaks: breaks.rows,
          columnBreaks: breaks.columns
        });
    // Qualified with the sheet name here, because the part writer works on one sheet and has
    // no name to use.
    unsupported.push(...written.unsupported.map(entry => `${sheetName}!${entry}`));
    unsupported.push(...merges.unsupported.map(entry => `${sheetName}!${entry}`));
    // Features the sheet carries that no record here emits. Scanned rather than reported by the
    // record writers, because nothing in them touches these fields — an unwritten feature leaves no
    // trace in the code that does not write it.
    unsupported.push(...worksheetLosses(worksheet).map(entry => `${sheetName}: ${entry}`));
    unsupported.push(...drawingLosses.splice(0).map(entry => `${sheetName}: ${entry}`));
    return {
      path: `xl/worksheets/sheet${index + 1}.bin`,
      bytes: written.bytes,
      // Relationships this sheet declares to preserved parts — a drawing, a picture. Carried here
      // because the sheet's part path is decided here, and a `.rels` file has to sit beside it.
      opaqueRels: worksheet.opaqueRels ?? [],
      // Written into this sheet's `.rels` with `TargetMode="External"`, which is what makes a hyperlink
      // a hyperlink: `BrtHLink` names the relationship and the relationship names the URL.
      hyperlinks: links,
      tables,
      ...(drawing === undefined ? {} : { drawing }),
      ...(commentRels === undefined ? {} : { comments, commentRels }),
      ...(background === undefined || backgroundRel === undefined
        ? {}
        : { background: { medium: background, rId: backgroundRel } }),
      ...(headerImages.length === 0 || headerFooterRel === undefined
        ? {}
        : { headerImages, headerFooterRel }),
      ...(threadedComments === undefined || threadedCommentRel === undefined
        ? {}
        : { threadedComments, threadedCommentRel }),
      ...(formControlRels.length === 0 ? {} : { formControlRels }),
      ...(legacyVmlRel === undefined ? {} : { legacyDrawingRelationshipId: legacyVmlRel })
    };
  });

  // Both are written after the worksheets, because the worksheets are what filled them in.
  const sharedStrings = strings.texts.length > 0 ? writeSharedStrings(strings) : undefined;
  // Always, as Excel does. Omitting it for a workbook that uses only the default format looked like
  // restraint and was not: every cell record carries a style index, and a package where those
  // indices point at a table that is not present is one Excel declines to open.
  // Named cell styles. Their facets are interned *before* the tables are serialised, so a style that
  // bolds its text shares the bold font record with any cell that does — and so `table.fontIndex` can
  // resolve it at all, which it cannot for a font it has never seen.
  // An *array*, each entry already carrying its own `name` — not a record keyed by name. Reading it as
  // a record produced styles called "0" and "1", and those names round-tripped.
  const namedStyles = (
    (model as unknown as { cellStyles?: readonly NamedStyleLike[] }).cellStyles ?? []
  ).filter(style => typeof style.name === "string" && style.name !== "");
  for (const named of namedStyles) {
    internStyle(formats, {
      ...(named.numFmt === undefined ? {} : { numberFormat: named.numFmt }),
      ...(named.font === undefined ? {} : { font: named.font }),
      ...(named.fill === undefined ? {} : { fill: named.fill }),
      ...(named.border === undefined ? {} : { border: named.border }),
      ...(named.alignment === undefined ? {} : { alignment: named.alignment }),
      ...(named.protection === undefined ? {} : { protection: named.protection })
    });
  }
  const styles = writeStyles(formats, model.defaultFont, namedStyles, dxfIndex.styles);

  // Parts the reader preserved verbatim — the theme, media, drawings, a VBA project. Filtered to
  // the ones still reachable, so deleting a sheet that pointed at a drawing does not leave the
  // drawing behind with nothing referencing it.
  const opaque = reachableOpaqueParts(model, sheetParts);
  const opaqueParts = opaque.parts;
  unsupported.push(...opaque.drops);
  // The theme, which a `{ theme: n }` colour resolves through. An XLSB *read* keeps it as an opaque part
  // — so it survived a same-format round trip and nothing noticed — but an XLSX read **models** it, and
  // this writer looked only at the opaque set. So every XLSX→XLSB conversion produced a package whose
  // cells still carried theme indices and whose theme part was gone, which is a workbook Excel renders in
  // different colours. Modelled themes are written here; a preserved one stays in `opaqueParts`.
  //
  // Deliberately computed *after* the reachability filter, not beside the other reserved paths: the
  // built-in fallback has to be suppressed by a theme that will actually be written, and a preserved
  // part that survived the read but lost its referrer is not one. Deciding it from the unfiltered
  // `opaqueParts` produced a package with no theme at all — the fallback stood down for a part that was
  // then dropped — which is the very failure the fallback exists to prevent. Nothing collides by moving
  // it: `themePath` is always `xl/theme/*`, while the reservations taken before this point are
  // `xl/media/*` and `xl/drawings/*`.
  const themes = themeParts(model, reservedPaths, opaqueParts);
  // Extensions this writer declares itself. A preserved part that relied on a conflicting
  // `Default` for one of these needs an `Override` instead, or this writer's value silently
  // reclassifies it — `bin` matters here in a way it does not for XLSX, because the workbook part
  // is declared through it.
  const reservedExtensions = new Map<string, string>([
    // `bin` is this writer's own, and the comment above said so while the map left it out. A
    // preserved part named `*.bin` that relied on a different `Default` was therefore reclassified as
    // a binary workbook part without the promotion to an `Override` that exists to prevent exactly
    // that.
    ["bin", WORKBOOK_CONTENT_TYPE],
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
    // The image extensions are declared below as `Default`s too, so they belong here for the same
    // reason — and this is the set the XLSX writer already reserves.
    ...media.contentTypes,
    // **`vml` too, because this writer declares it below and the map decides who may.**
    //
    // A preserved VML whose source declared it through a `Default` would otherwise have that `Default` re-emitted
    // beside this writer's, and OPC allows one `Default` per extension. It does not reproduce on the two corpus files
    // that carry VML — theirs arrive with an explicit `contentType`, which takes the `Override` path — so the collision
    // depends on how the producer happened to declare it. Reserving the extension makes the outcome a property of this
    // writer rather than of the file it read.
    ["vml", "application/vnd.openxmlformats-officedocument.vmlDrawing"]
  ]);
  const opaqueDeclarations = opaqueContentTypeDeclarations(
    opaqueParts,
    model.opaqueContentTypeDefaults,
    reservedExtensions
  );

  // Derived from the sheets rather than collected while writing them: `[Content_Types].xml` is added to
  // the archive before the sheet parts are, so a list filled in during that loop would still be empty
  // here and every comments part would go undeclared — a package Excel rejects.
  // Table part paths, numbered by a single running index across the whole workbook — a table's part
  // number is not its position within its sheet. Derived once and used by both the content-type
  // declaration and the loop that writes them, so the two cannot disagree about how many there are.
  //
  // **Numbered past whatever preserved parts already occupy**, for the reason `nextChartNumber` is: a table read from a
  // package this library keeps opaque never enters the model's table list, so counting from 1 reissues `table1.bin` and
  // the preserved copy is the one the writer drops. Charts had the identical defect and destroyed a chart with it.
  const tablePathBySheet = sheetParts.map(() => [] as string[]);
  // A running counter rather than one derived from how many paths have been pushed: skipping a reserved number makes the
  // two disagree, and the first version of this fix handed `table2.bin` out twice because of it — one table allocated it
  // by skipping `table1.bin`, and the next derived `2` from a count of one.
  let nextTableNumber = 1;
  const nextTablePath = (): string => {
    while (reservedPaths.has(`xl/tables/table${nextTableNumber}.bin`)) {
      nextTableNumber += 1;
    }
    const path = `xl/tables/table${nextTableNumber}.bin`;
    nextTableNumber += 1;
    return path;
  };
  sheetParts.forEach((part, sheet) => {
    for (const _table of part.tables) {
      void _table;
      tablePathBySheet[sheet].push(nextTablePath());
    }
  });
  const tablePaths = tablePathBySheet.flat();
  // Pivot tables. Each is a view part plus a *cache*, and the two are numbered independently because a
  // cache can be shared: two views built from the same source data carry the same `cacheId`, and
  // `BrtBeginPivotCacheID.idSx` MUST be unique in its collection — so a cache is written once and both
  // views point at it. Writing one per view instead produced two bindings with the same `idSx`, which is
  // the defect this shape exists to prevent (the XLSX writer dedupes by `cacheId` for the same reason).
  //
  // They are planned together with their parts because the specification ties them: the package MUST
  // contain one cache definition part per `BrtBeginPivotCacheID` record in the workbook, so a plan that
  // counted the two separately is how a package ends up declaring a cache it does not contain.
  interface PivotCachePlan {
    readonly cacheId: number;
    readonly cache: PivotCacheModel;
    readonly definitionPath: string;
    readonly recordsPath: string;
    /** The definition's own relationship to its records part, in that file's private id space. */
    readonly recordsRel: string;
  }
  interface PivotViewPlan {
    readonly sheet: number;
    readonly view: PivotViewModel;
    readonly cache: PivotCachePlan;
    readonly tablePath: string;
    /** The sheet relationship that names the view part. */
    readonly tableRel: string;
  }
  const pivotCachePlans: PivotCachePlan[] = [];
  const pivotViewPlans: PivotViewPlan[] = [];
  const cachePlanById = new Map<number, PivotCachePlan>();
  worksheets.forEach((worksheet, sheet) => {
    const source = worksheet as unknown as { pivotTables?: readonly PivotTable[] };
    for (const pivot of source.pivotTables ?? []) {
      const built = pivotParts(pivot, "rId1");
      if (built === undefined) {
        // **Reported, not skipped in silence.** `pivotParts` needs the live source worksheet and the cache
        // fields, which only a pivot authored in this session through `Pivot.add` carries — a pivot *read* from
        // an XLSX arrives in the parsed form (`pivotFields`, `colFields`, `dataFields`) with neither. So an
        // XLSX→XLSB conversion drops its pivot tables, and this `continue` used to be the whole of it: no
        // record in `unsupported`, so `unsupported: "error"` did not refuse and the caller was told nothing.
        //
        // Naming it does not implement the conversion — that needs the parsed form to be adapted, or the cache
        // preserved the way an XLSB read preserves it in `xlsbPivotCaches` — but it does stop the loss from
        // being invisible, which is the standing rule for everything this writer cannot express.
        const name = (pivot as { name?: string }).name;
        unsupported.push(
          `${worksheet.name ?? `Sheet${sheet + 1}`}: pivot table` +
            `${name === undefined ? "" : ` ${name}`} read from another container`
        );
        continue;
      }
      let cache = cachePlanById.get(built.view.cacheId);
      if (cache === undefined) {
        const number = pivotCachePlans.length + 1;
        cache = {
          cacheId: built.view.cacheId,
          cache: built.cache,
          definitionPath: `xl/pivotCache/pivotCacheDefinition${number}.bin`,
          recordsPath: `xl/pivotCache/pivotCacheRecords${number}.bin`,
          recordsRel: "rId1"
        };
        pivotCachePlans.push(cache);
        cachePlanById.set(cache.cacheId, cache);
      }
      const number = pivotViewPlans.length + 1;
      pivotViewPlans.push({
        sheet,
        view: built.view,
        cache,
        tablePath: `xl/pivotTables/pivotTable${number}.bin`,
        tableRel: `rId${number}Pivot`
      });
    }
  });

  // Charts, by part number. `chartEntries` is on the *workbook* — `Chart.add` registers there — so the
  // list is the same for every sheet and is derived once. Every entry becomes a part, whether or not a
  // sheet still anchors it: a chart whose anchor was removed is a part with nothing pointing at it, which
  // is the same shape as a preserved-but-unreferenced drawing and equally something Excel tolerates.
  // Each chartsheet is a `.bin` sheet plus a drawing that fills it — and the drawing, its relationships and the chart
  // itself all come from the XLSX writer, because a chart part is XML in both containers. So only the sheet needed
  // BIFF12. `chartsheets` itself is read at the top, because the tab order depends on it.
  const chartsheetParts = chartsheets.map((chartsheet, index) => ({
    chartsheet,
    // Numbered independently of the worksheets: a chartsheet is `xl/chartsheets/sheetN.bin`, a different
    // directory, so the two sequences do not collide.
    path: `xl/chartsheets/sheet${index + 1}.bin`,
    drawingName: `chartsheetDrawing${index + 1}`
  }));

  const chartEntries = (model as unknown as { chartEntries?: Record<string, unknown> })
    .chartEntries;
  const chartNumbers = Object.keys(chartEntries ?? {})
    .map(Number)
    .filter(number => Number.isFinite(number) && number > 0)
    .sort((left, right) => left - right);
  // Sheets with threaded comments, by part number. Derived before the archive is assembled for the same
  // reason the comment paths are: `[Content_Types].xml` is written first, and a list filled in later
  // would leave every threaded-comment part undeclared.
  const threadedCommentSheetIds = sheetParts
    .map((part, index) => (part.threadedComments === undefined ? undefined : index + 1))
    .filter((id): id is number => id !== undefined);
  // The workbook-level author list a threaded comment's `personId` points at. Without it the comments
  // are present and attributed to nobody, which Excel shows as an empty name.
  const persons = ((model as unknown as { persons?: readonly unknown[] }).persons ??
    []) as readonly {
    readonly id?: string;
  }[];
  const commentPaths = sheetParts
    .map((part, index) => (part.comments === undefined ? undefined : `xl/comments${index + 1}.bin`))
    .filter((path): path is string => path !== undefined);

  /**
   * Where the parts go, and the list of what went there.
   *
   * `[Content_Types].xml` is **derived** from `sink.paths` rather than predicted from what ought to be present.
   * The prediction is what failed: `hasVml` was `commentPaths.length > 0`, and a workbook whose only VML is a
   * header picture — a watermark — shipped `vmlDrawing1_hf.vml` with no content type declared for its extension.
   * Excel refuses a package containing a part it cannot type. Restating the three VML producers here instead
   * would have fixed that one case and left the next one to find, because the list and the writers can drift.
   *
   * The content types are therefore written **last**, which the ZIP format permits — entry order is not part of
   * the container's contract, and `ZipArchive` sorts anyway so `[Content_Types].xml` still lands first in the
   * file. That freedom is what makes this writer usable from a streaming destination as well as a buffered one:
   * a `PackageSink` is either, and nothing below this line knows which.
   */
  const sink: PackageSink = options?.sink ?? new ArchiveSink();
  const partPaths = sink.paths;
  // **Every part goes through here, and a path may only be written once.**
  //
  // OPC forbids two `Override` entries for one part name, and a reader is entitled to treat the duplicate as damage
  // rather than as redundancy — LibreOffice refuses the package outright ("source file could not be loaded"), which is
  // a harsher response than a warning and a correct one.
  //
  // The guard is here rather than at the call sites because there are more than thirty of them and the collision does
  // not need two of them to be wrong: reading a workbook whose charts, drawings and tables arrive as *opaque* parts and
  // writing it back was enough. Those parts are emitted by the preserved-part loop, and the same paths are then
  // declared again by the writer that owns that kind of part — sixteen duplicates on `sales-dashboard`, none of which
  // any test saw, because this library's own reader is happy to read the first of a duplicated pair.
  //
  // **The first write wins, and the comment here used to claim that meant the preserved copy. It did not.**
  //
  // The generated parts are emitted before the preserved-part loop, so on a genuine collision the *preserved* copy was
  // the one dropped — the reverse of what this said. That was not theoretical: a chart read as an opaque part never
  // enters `_chartEntries`, so `nextChartNumber` reissued `1`, the new chart was written to `chart1.xml` first, and the
  // chart the workbook arrived with was silently discarded while its drawing still pointed at that path. The numbering
  // is fixed at the source (`nextChartNumber` now counts preserved parts as taken), so the paths no longer collide.
  //
  // Which copy wins therefore stops being a policy and becomes an assertion: a collision now means a *numbering* bug
  // upstream, and one that has already destroyed data once. `collisions` records them so the caller is told rather than
  // guessing, since dropping either copy is wrong when the bytes differ.
  const writtenPaths = new Set<string>();
  const collisions: string[] = [];
  /**
   * Add a part and let a streamed destination catch up.
   *
   * **`PackageSink.drain` was never called by this writer, though the module header claimed backpressure was observed
   * between parts.** It is called now, at the boundaries where a part is large — a worksheet, an image, a preserved
   * part — rather than after all thirty-odd `addPart` calls, since the rest are content types and relationship files
   * measured in kilobytes.
   *
   * **What that does *not* buy, measured rather than assumed.** Against a deliberately slow writable the peak bytes in
   * flight are unchanged by these awaits, because the peak is not a queue of parts — it is *one* part. Node calls
   * `_write` serially, so the largest single `write()` is the bound, and for a string-heavy workbook that call carries
   * `sharedStrings.bin`: 2.93 MB of a 5.93 MB package (16 sheets × 9,000 rows × 8 columns, so 1.15 M distinct strings),
   * with `writableLength` peaking at exactly the same 2.93 MB. Scaling the workbook scales both together.
   *
   * So the honest statement is: draining bounds the *queue between* parts, and the remaining bound is the largest part
   * itself. Lowering that needs the part to stream — `sink.open()` and incremental writes, which the interface already
   * offers and `writeSharedStrings` does not use. That is real work with a real payoff for exactly this shape of
   * workbook, and it is not what these three awaits are.
   */
  const addPartAndDrain = async (path: string, data: Uint8Array | string): Promise<void> => {
    addPart(path, data);
    await sink.drain();
  };
  const addPart = (path: string, data: Uint8Array | string): void => {
    // Compared case-insensitively because OPC part names are, and a duplicate that differs only in case is still a
    // duplicate to the reader that rejects it.
    const key = path.toLowerCase();
    if (writtenPaths.has(key)) {
      // Duplicated *declarations* of one part are ordinary — several writers legitimately describe the same content type
      // — and the content types are deduplicated separately. A duplicated *part* is not: two writers produced bytes for
      // one name, and only one of them can be in the package.
      collisions.push(path);
      return;
    }
    writtenPaths.add(key);
    sink.part(path, data);
  };
  const rootRels = [
    { Id: "rId1", Type: OFFICE_DOCUMENT_REL, Target: "xl/workbook.bin" },
    {
      Id: "rId2",
      Type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
      Target: "docProps/core.xml"
    },
    {
      Id: "rId3",
      Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
      Target: "docProps/app.xml"
    }
  ];
  // A preserved part reached from the *package root* rather than from the workbook — `docProps/
  // custom.xml` is the common one — needs its relationship carried across as well. Only the workbook's
  // were, so `reachableOpaqueParts` kept such a part (it counts every inbound edge the model holds)
  // and then nothing pointed at it: an orphan, which is exactly the state the reachability filter
  // exists to avoid. The XLSX writer has always appended both; this is the same call with the root's
  // empty source name.
  appendOpaqueSourceRelationships(rootRels, opaqueParts, "");
  addPart("_rels/.rels", relationships(rootRels));
  // Reused from the XLSX path rather than hand-written: the two documents are identical whichever
  // container they travel in, and a second serialiser would be a second thing to drift.
  addPart("docProps/core.xml", renderXform(new CoreXform(), model));
  addPart("docProps/app.xml", renderXform(new AppXform(), model));

  const workbookRels = sheetParts.map((part, index) => {
    // **A chartsheet placeholder points at the chartsheet, not at a worksheet part it does not have.**
    //
    // The reader cannot model a chartsheet, so it keeps the name and position as an empty worksheet and records the
    // path of the part that sheet really is. Writing that placeholder as an ordinary sheet produced a 319-byte empty
    // grid, gave it this relationship, and left the preserved chartsheet reachable only through a *second*
    // relationship the sheet bundle never names — thirteen targets against twelve `BrtBundleSh` records, with the
    // chart sheet resolving to the empty grid. The package still opened; it just no longer held the chart sheet.
    const placeholder = placeholderFor(index);
    return placeholder === undefined
      ? { Id: `rId${index + 1}`, Type: WORKSHEET_REL, Target: `worksheets/sheet${index + 1}.bin` }
      : {
          Id: `rId${index + 1}`,
          Type: CHARTSHEET_REL,
          // Relative to `xl/`, the way every other target in this document is.
          Target: placeholder.replace(/^xl\//, "")
        };
  });
  // Chartsheets follow the worksheets, so their relationship ids continue the same sequence — the sheet
  // bundle below points at these by id, and a bundle entry naming an id no relationship carries is a
  // sheet Excel cannot open.
  const chartsheetRelIds = chartsheetParts.map((entry, index) => {
    const id = `rId${workbookRels.length + 1}`;
    workbookRels.push({
      Id: id,
      Type: CHARTSHEET_REL,
      Target: `chartsheets/sheet${index + 1}.bin`
    });
    return id;
  });
  // The cache definitions, reached from the workbook by an *explicit* relationship whose id each
  // `BrtBeginPivotCacheID` record carries. The id is captured rather than recomputed because the record and
  // the relationship have to agree, and a second count is a second thing to get wrong.
  const pivotCacheBindings: PivotCacheBinding[] = pivotCachePlans.map(plan => {
    const id = `rId${workbookRels.length + 1}`;
    workbookRels.push({
      Id: id,
      Type: RelType.PivotCacheDefinition,
      Target: plan.definitionPath.replace(/^xl\//, "")
    });
    return { cacheId: plan.cacheId, relationshipId: id };
  });
  if (sharedStrings) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: SHARED_STRINGS_REL,
      Target: "sharedStrings.bin"
    });
  }
  for (const theme of themes) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: RelType.Theme,
      Target: theme.path.replace(/^xl\//, "")
    });
  }
  if (persons.length > 0) {
    // A threaded comment's `personId` resolves through this part. Excel reaches it from the *workbook*,
    // not from a sheet, which is why the relationship goes here.
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: RelType.Person,
      Target: "persons/person.xml"
    });
  }
  if (styles) {
    workbookRels.push({
      Id: `rId${workbookRels.length + 1}`,
      Type: STYLES_REL,
      Target: "styles.bin"
    });
  }
  // `workbook.bin.rels`, not `workbook.xml.rels`. OPC locates a part's relationships at
  // `<dir>/_rels/<filename>.rels`, so the `.xml` name meant the workbook part had no
  // relationships at all as far as the package was concerned — the sheets were unreachable
  // through the only mechanism that makes them reachable. Nothing caught it because this
  // library's own reader computed the sheet paths arithmetically instead of following them.
  // A preserved part reached from the workbook needs its relationship carried across too, or it
  // sits in the package unreferenced — which is one of the things Excel offers to repair.
  appendOpaqueSourceRelationships(workbookRels, opaqueParts, "xl/workbook.bin");
  // **A chartsheet placeholder's relationship is now written twice, so drop the second.**
  //
  // The sheet bundle points at the one built above, by id. The preserved-part pass then finds the same chartsheet still
  // carrying its own inbound relationship from the workbook and appends that too — under a *renumbered* id, since the
  // original is taken. Two relationships for one part is not fatal, but the extra is unreachable from the bundle and is
  // exactly the orphan `reachableOpaqueParts` exists to avoid.
  //
  // Matched on target rather than on id, because the id is the part that was rewritten.
  const bundleTargets = new Set(
    sheetParts
      .map((_, index) => placeholderFor(index))
      .filter((path): path is string => path !== undefined)
      .map(path => path.replace(/^xl\//, "").toLowerCase())
  );
  if (bundleTargets.size > 0) {
    for (let index = workbookRels.length - 1; index >= 0; index -= 1) {
      const rel = workbookRels[index]!;
      if (rel.Type === CHARTSHEET_REL && bundleTargets.has(rel.Target.toLowerCase())) {
        // Keep the first, which is the one the bundle names.
        const first = workbookRels.findIndex(
          candidate =>
            candidate.Type === CHARTSHEET_REL &&
            candidate.Target.toLowerCase() === rel.Target.toLowerCase()
        );
        if (first !== index) {
          workbookRels.splice(index, 1);
        }
      }
    }
  }

  // The bindings a *read* preserved. The three pivot parts come through as opaque bytes, so a workbook that
  // was read rather than built has no `pivotTables` to plan from — but `workbook.bin` is rebuilt, and without
  // these the cache definition survives while the record announcing it does not. The specification requires
  // one definition part per binding record; the result was the reverse of a dangling reference, and just as
  // much a repair prompt.
  //
  // **Matched by part path, not by the preserved relationship id.** The workbook relationships are renumbered
  // on each write — a definition that came in as `rId3` goes out as `rId5` — so a binding that kept its old id
  // named a relationship this package does not contain. That failed silently the *second* time round: the
  // first write reproduced the id by coincidence and only a three-generation round trip showed it.
  const preservedCacheDefinitions = new Map<string, string>();
  for (const relationship of workbookRels) {
    if (relationship.Type === RelType.PivotCacheDefinition) {
      preservedCacheDefinitions.set(`xl/${relationship.Target}`.toLowerCase(), relationship.Id);
    }
  }
  const takenCacheIds = new Set(pivotCacheBindings.map(binding => binding.cacheId));
  const preserved = (model as unknown as { xlsbPivotCaches?: readonly PivotCacheBinding[] })
    .xlsbPivotCaches;
  // **Paired by the binding's own part path, and it used to be paired by array position.**
  //
  // Position is not an ordering both sides share: the reader collects bindings in the order `workbook.bin` declares them,
  // and the preserved parts arrive in ZIP order. Nothing in OPC makes those the same, so two caches delivered in the
  // opposite order bound each `cacheId` to the *other* one's definition — every part present, the package structurally
  // valid, and both pivots reading the wrong data. That is the worst shape available: a validator cannot see it and
  // neither can a round trip through this library.
  //
  // The reader now resolves each binding's relationship to a path (`PivotCacheBinding.definitionPath`), which is the key
  // that means the same thing on both sides. Position remains the fallback for a package whose `.rels` could not be
  // read, and that case is reported rather than pretended away.
  const preservedPaths = (model.opaqueParts ?? [])
    .filter(part => part.contentType === PIVOT_CACHE_DEFINITION_CONTENT_TYPE)
    .map(part => part.path.toLowerCase());
  for (const [index, binding] of (preserved ?? []).entries()) {
    const declared = (binding as { definitionPath?: string }).definitionPath;
    const path = declared ?? preservedPaths[index];
    if (declared === undefined) {
      unsupported.push(
        `pivot cache ${binding.cacheId}: bound by position because its relationship could not be resolved`
      );
    }
    const relationshipId = path === undefined ? undefined : preservedCacheDefinitions.get(path);
    if (relationshipId === undefined || takenCacheIds.has(binding.cacheId)) {
      continue;
    }
    takenCacheIds.add(binding.cacheId);
    pivotCacheBindings.push({ cacheId: binding.cacheId, relationshipId });
  }

  addPart("xl/_rels/workbook.bin.rels", relationships(workbookRels));

  const book = model as unknown as {
    views?: readonly WorkbookViewLike[];
    protection?: BookProtectionLike;
  };
  // **In tab order, not worksheets-then-chartsheets.** The bundle is what Excel draws the tab bar from, so
  // appending the chartsheets put `financial-report`'s "Board View" — its *first* tab — at the end. The order
  // is decided by `core/sheet-order`, which the XLSX writer uses for the same purpose; deciding it here as well
  // is how the two writers came to disagree about the same model.
  //
  // Chartsheets belong in the bundle at all because a workbook that writes the parts and omits the entries has
  // files nothing reaches, and Excel shows no tab for them.
  const workbookPart = writeWorkbookPart(
    sheetsInTabOrder(
      worksheets.map((worksheet, index) => ({
        name: worksheet.name ?? `Sheet${index + 1}`,
        relationshipId: `rId${index + 1}`,
        orderNo: (worksheet as { orderNo?: number }).orderNo,
        sheetNo: index + 1,
        ...(worksheet.state === undefined ? {} : { state: worksheet.state })
      })),
      chartsheetParts.map((entry, index) => ({
        name: entry.chartsheet.name ?? `Chart${index + 1}`,
        relationshipId: chartsheetRelIds[index],
        orderNo: (entry.chartsheet as { orderNo?: number }).orderNo,
        sheetNo: index + 1,
        ...(entry.chartsheet.state === undefined
          ? {}
          : { state: entry.chartsheet.state as "visible" | "hidden" | "veryHidden" })
      }))
    ),
    // After the sheets, so the extern-sheet table already holds any span a formula appended.
    {
      date1904,
      definedNames,
      pivotCaches: pivotCacheBindings,
      formulaContext,
      externSheets: formulaContext.externSheets,
      ...(model.calcProperties === undefined ? {} : { calcProperties: model.calcProperties }),
      // Read through one cast rather than four: the model's `views` and `protection` are typed loosely
      // here on purpose, because this writer takes only the fields the two records carry.
      ...(book.views === undefined ? {} : { views: book.views }),
      ...(book.protection === undefined ? {} : { protection: book.protection })
    }
  );
  addPart("xl/workbook.bin", workbookPart.bytes);
  // The workbook-level author list. Written after the workbook part because its relationship goes into
  // the workbook's own `.rels`, which is assembled from the ids allocated below.
  if (persons.length > 0) {
    addPart("xl/persons/person.xml", stringToUint8Array(renderPersonList(persons as never)));
  }
  unsupported.push(...workbookPart.unsupported);
  unsupported.push(...workbookLosses(model));
  // Images: the bytes, the drawing part that places them, and that part's own relationships. All
  // three are shared with the XLSX path — the media are opaque bytes, the drawing is XML rendered by
  // `DrawingXform`, and only the reference from the sheet is binary.
  for (const part of media.parts) {
    // An image is the largest thing in most packages — see `addPartAndDrain`.
    await addPartAndDrain(part.path, part.bytes);
  }
  if (drawings.length > 0) {
    const { DrawingXform } = await import("@excel/xlsx/xform/drawing/drawing-xform");
    for (const drawing of drawings) {
      const xform = new DrawingXform();
      xform.prepare(drawing);
      const writer = new XmlWriter();
      xform.render(writer, drawing);
      addPart(drawingPath(drawing.name), writer.xml);
      addPart(drawingRelsPath(drawing.name), relationships(drawing.rels));
    }
  }

  // Indexed once. Every sheet relationship used to scan the whole opaque set, lower-casing each
  // candidate path again on every comparison — O(relationships × parts) for a question that is a set
  // membership test.
  const opaquePaths = new Set(opaqueParts.map(part => part.path.toLowerCase()));
  for (const [sheet, part] of sheetParts.entries()) {
    // A chartsheet placeholder has no part of its own — its relationship points at the preserved chartsheet instead
    // (see `workbookRels` above), and everything else in this loop describes a cell grid the sheet does not have.
    if (placeholderFor(sheet) !== undefined) {
      continue;
    }
    // A streamed sheet is already in the sink, written one row at a time. Everything *else* this loop does for it
    // — the `.rels`, the tables, the comments, the VML, the control properties — still has to happen, which is
    // why the skip is one line here rather than a branch around the loop. Writing the part again would put a
    // second copy of the entry in the ZIP and a duplicate `Override` in the content types, and Excel treats a
    // duplicated part name as malformed rather than redundant.
    if (!alreadyWritten.has(part.path)) {
      // The biggest part in a data-heavy workbook, and the one whose bytes a streamed caller most wants moved on.
      await addPartAndDrain(part.path, part.bytes);
    }
    // A sheet that reached a preserved part keeps the relationship that reached it. Without this the
    // part survives with nothing pointing at it, which Excel treats as damage rather than as a file
    // with an unused part in it.
    const sheetRels: { Id: string; Type: string; Target: string; TargetMode?: string }[] =
      part.drawing === undefined
        ? []
        : [
            {
              Id: part.drawing.rId,
              Type: RelType.Drawing,
              Target: drawingRelTargetFromWorksheet(part.drawing.name)
            }
          ];
    for (const link of part.hyperlinks) {
      // An internal link has no relationship to write — see the id allocation above.
      if (link.relationshipId === "") {
        continue;
      }
      sheetRels.push({
        Id: link.relationshipId,
        Type: RelType.Hyperlink,
        Target: link.target,
        TargetMode: "External"
      });
    }
    // Tables: one part each, reached by an explicit relationship from the sheet **and named by a
    // `BrtListPart` in the sheet's record stream**. This comment used to assert the opposite — that the
    // relationship was the only link — and that belief is precisely why no `BrtListPart` was written and why
    // every table went out invisible. The part is still written here because this is where the relationship
    // is recorded; the record naming it is emitted by the worksheet writer, from the same list.
    part.tables.forEach((table, position) => {
      const bytes = encodeTablePart(table);
      const path = tablePathBySheet[sheetParts.indexOf(part)][position];
      if (bytes === undefined || path === undefined) {
        return;
      }
      addPart(path, bytes);
      sheetRels.push({
        Id: table.relationshipId,
        Type: RelType.Table,
        // Relative to the sheet, which sits one directory deeper.
        Target: `../${path.slice("xl/".length)}`
      });
    });

    // Threaded comments. The part is XML — `renderThreadedComments` is the XLSX writer's own renderer, and
    // there is no BIFF12 form of a threaded comment, so this is a passthrough rather than a translation.
    if (part.threadedComments !== undefined && part.threadedCommentRel !== undefined) {
      const index = sheetParts.indexOf(part) + 1;
      addPart(
        `xl/threadedComments/threadedComment${index}.xml`,
        stringToUint8Array(renderThreadedComments(part.threadedComments as never))
      );
      sheetRels.push({
        Id: part.threadedCommentRel,
        Type: RelType.ThreadedComments,
        Target: `../threadedComments/threadedComment${index}.xml`
      });
    }

    // A background image: one relationship, pointing straight at the medium. No new part — the image
    // bytes are already in `xl/media/` because `planMedia` wrote every usable medium there.
    if (part.background !== undefined) {
      const target = mediaTarget(part.background.medium.imageId, media.named);
      if (target !== undefined) {
        sheetRels.push({ Id: part.background.rId, Type: RelType.Image, Target: target });
      }
    }

    // Header, footer and watermark pictures: a VML part holding their geometry, its own `.rels` naming
    // the images, and the sheet relationship `BrtLegacyDrawingHF` points at. Three levels, which is why
    // this is more than a relationship: the VML references the images by *its own* relationship ids, so
    // it needs a `.rels` of its own.
    if (part.headerImages !== undefined && part.headerFooterRel !== undefined) {
      const index = sheetParts.indexOf(part) + 1;
      const vmlPath = `xl/drawings/vmlDrawing${index}_hf.vml`;
      const vmlWriter = new XmlWriter();
      const imageRels: { Id: string; Type: string; Target: string }[] = [];
      new VmlDrawingXform().render(vmlWriter, {
        comments: [],
        formControls: [],
        headerImages: part.headerImages.map((medium, position) => {
          const relationshipId = `rId${position + 1}`;
          const target = mediaTarget(medium.imageId, media.named);
          if (target !== undefined) {
            imageRels.push({ Id: relationshipId, Type: RelType.Image, Target: target });
          }
          return {
            imageRelId: relationshipId,
            width: (medium as { headerWidth?: number }).headerWidth,
            height: (medium as { headerHeight?: number }).headerHeight,
            position: (medium as { position?: string }).position
          };
        })
      } as never);
      addPart(vmlPath, vmlWriter.xml);
      if (imageRels.length > 0) {
        addPart(relationshipsPathFor(vmlPath), relationships(imageRels));
      }
      sheetRels.push({
        Id: part.headerFooterRel,
        Type: RelType.VmlDrawing,
        Target: `../drawings/vmlDrawing${index}_hf.vml`
      });
    }

    // Comments and form controls, which **share one VML file**. That is not a shortcut: Excel writes a
    // single `vmlDrawing{N}.vml` per sheet holding both a note's box and a checkbox's shape, and writing
    // two would leave one of them unreachable — the sheet has one `BrtLegacyDrawing`.
    //
    // A comment additionally needs `comments{N}.bin`; without it the boxes are there and empty. A control
    // additionally needs `xl/ctrlProps/ctrlProp{N}.xml`; without it Excel offers to repair the sheet.
    // 1-based, because a part path is `sheet1.bin` for the first sheet.
    const sheetIndex = sheet + 1;
    const controls = part.formControlRels ?? [];
    if (
      part.legacyDrawingRelationshipId !== undefined &&
      ((part.commentRels !== undefined && part.comments !== undefined) || controls.length > 0)
    ) {
      const vmlPath = `xl/drawings/vmlDrawing${sheetIndex}.vml`;
      const vmlWriter = new XmlWriter();
      new VmlDrawingXform().render(vmlWriter, {
        comments: (part.comments ?? []).map(comment => {
          const cell = decodeCell(comment.ref);
          return {
            ref: comment.ref,
            // `refAddress` is not redundant with `ref`: the anchor xform sizes the default note box from
            // the cell's *coordinates*, and it reads them from here rather than parsing the reference
            // itself. The XLSX writer attaches it for the same reason.
            refAddress: { row: cell.r + 1, col: cell.c + 1 },
            // The note as the model holds it, defaults included. `note.texts` is the same array as
            // `comment.texts`; both are named because the VML renderer reads the former.
            note: comment.note ?? { texts: comment.texts }
          };
        }),
        formControls: controls.map(entry => entry.control)
      } as never);
      addPart(vmlPath, vmlWriter.xml);

      // **One VML relationship, whichever of the two needed the file.** `BrtLegacyDrawing` names this one
      // id, and a sheet with controls and no comments still needs it — the first version of this only
      // emitted the relationship when there were comments, so a checkbox reached Excel with its VML
      // present and nothing pointing at it, which is a sheet Excel offers to repair.
      sheetRels.push({
        Id: part.legacyDrawingRelationshipId!,
        Type: RelType.VmlDrawing,
        Target: `../drawings/vmlDrawing${sheetIndex}.vml`
      });
    }

    if (part.commentRels !== undefined && part.comments !== undefined) {
      const commentsPartPath = `xl/comments${sheetIndex}.bin`;
      addPart(commentsPartPath, encodeCommentsPart(part.comments));
      sheetRels.push({
        Id: part.commentRels.part,
        Type: RelType.Comments,
        Target: `../comments${sheetIndex}.bin`
      });
    }

    // One `ctrlProp` part per control, each with its own relationship. Rendered by the XLSX writer's own
    // xform — a control's properties are XML in both containers.
    for (const entry of controls) {
      const writer = new XmlWriter();
      new CtrlPropXform().render(writer, entry.control as never);
      addPart(`xl/ctrlProps/ctrlProp${entry.ctrlPropId}.xml`, writer.xml);
      sheetRels.push({
        Id: entry.relationshipId,
        Type: RelType.CtrlProp,
        Target: `../ctrlProps/ctrlProp${entry.ctrlPropId}.xml`
      });
    }

    // **The shared predicate, because this one was the inverse of the XLSX writer's for the case that matters.**
    //
    // It required the target to resolve *and* name a preserved part, so a relationship whose target cannot be resolved —
    // an external URL, a `TargetMode="External"` hyperlink, a modelled part, anything this writer does not know — was
    // deleted here and kept there. The documented policy is to prune only what was deliberately excluded; see
    // `relationshipStillResolves`.
    const reachable = part.opaqueRels.filter(relationship =>
      relationshipStillResolves(part.path, relationship, opaquePaths)
    );
    for (const relationship of reachable) {
      sheetRels.push({
        Id: relationship.id,
        Type: relationship.type,
        Target: relationship.target,
        ...(relationship.targetMode === undefined ? {} : { TargetMode: relationship.targetMode })
      });
    }
    // Pivot tables: the sheet points at the view part, which points at the cache definition, which points at
    // the records. Three levels, and the sheet's is the only one added here.
    for (const plan of pivotViewPlans.filter(entry => entry.sheet === sheet)) {
      sheetRels.push({
        Id: plan.tableRel,
        Type: RelType.PivotTable,
        Target: `../pivotTables/${plan.tablePath.split("/").pop()}`
      });
    }
    if (sheetRels.length > 0) {
      addPart(relationshipsPathFor(part.path), relationships(sheetRels));
    }
  }

  // The four pivot parts. Written together for the reason the plan was built together: the specification
  // requires one cache definition per `BrtBeginPivotCacheID` record in the workbook, so a package with some
  // of these and not others points at things it does not contain.
  for (const plan of pivotViewPlans) {
    addPart(
      plan.tablePath,
      encodeBiffRecords(pivotViewRecords(plan.view).map(([name, payload]) => record(name, payload)))
    );
    // The view reaches its cache by an *implicit* relationship, which still needs declaring.
    addPart(
      relationshipsPathFor(plan.tablePath),
      relationships([
        {
          Id: "rId1",
          Type: RelType.PivotCacheDefinition,
          Target: `../pivotCache/${plan.cache.definitionPath.split("/").pop()}`
        }
      ])
    );
  }
  for (const plan of pivotCachePlans) {
    addPart(
      plan.definitionPath,
      encodeBiffRecords(
        pivotCacheDefinitionRecords(plan.cache).map(([name, payload]) => record(name, payload))
      )
    );
    addPart(
      relationshipsPathFor(plan.definitionPath),
      relationships([
        {
          Id: plan.recordsRel,
          Type: RelType.PivotCacheRecords,
          Target: plan.recordsPath.split("/").pop()!
        }
      ])
    );
    addPart(
      plan.recordsPath,
      encodeBiffRecords(
        pivotCacheRecordsRecords(plan.cache).map(([name, payload]) => record(name, payload))
      )
    );
  }

  // Chartsheet parts: the `.bin` sheet, its `.rels` naming the drawing, the drawing itself, and that
  // drawing's own `.rels` naming the chart. Four files per chartsheet, and the chart is already written
  // above — a chartsheet's chart is an ordinary `chartEntries` entry.
  for (const entry of chartsheetParts) {
    const number = entry.chartsheet.chartNumber ?? entry.chartsheet.chartExNumber ?? 0;
    if (number === 0) {
      continue;
    }
    const isChartEx = (entry.chartsheet.chartNumber ?? 0) === 0;
    const drawingRelId = "rId1";
    addPart(
      entry.path,
      encodeChartsheetPart({
        name: entry.chartsheet.name ?? "Chart",
        drawingRelationshipId: drawingRelId,
        // **Everything below used to be dropped on the floor.** This call passed the name and the relationship id and
        // nothing else, so `zoomToFit`, the zoom, the selection, the code name and the margins the model carried were
        // replaced by the encoder's defaults. `zoomToFit` is the one that showed: a chartsheet has no cell grid, so it
        // is what tells Excel how large to draw the chart, and without it `financial-report`'s "Board View" opened
        // blank in XLSB while the same workbook's XLSX — which writes `zoomToFit="1"` — rendered it.
        zoomToFit: entry.chartsheet.zoomToFit,
        zoomScale: entry.chartsheet.zoomScale,
        selected: entry.chartsheet.tabSelected,
        pageMargins: entry.chartsheet.pageMargins
      })
    );
    addPart(
      relationshipsPathFor(entry.path),
      relationships([
        { Id: drawingRelId, Type: RelType.Drawing, Target: `../drawings/${entry.drawingName}.xml` }
      ])
    );
    // The drawing uses an **absolute** anchor with concrete EMU sizes. A chartsheet has no cell grid, so a
    // cell-based anchor resolves to a 0×0 rectangle and Excel renders a blank canvas — which is why this
    // is the XLSX writer's own renderer rather than `DrawingXform`.
    addPart(
      `xl/drawings/${entry.drawingName}.xml`,
      stringToUint8Array(
        renderChartsheetDrawingXml({
          chartRId: "rId1",
          chartName: `Chart ${number}`,
          isChartEx,
          extCx: CHARTSHEET_DRAWING_EMU.cx,
          extCy: CHARTSHEET_DRAWING_EMU.cy
        })
      )
    );
    addPart(
      `xl/drawings/_rels/${entry.drawingName}.xml.rels`,
      relationships([
        {
          Id: "rId1",
          Type: isChartEx ? RelType.ChartEx : RelType.Chart,
          Target: isChartEx ? `../charts/chartEx${number}.xml` : `../charts/chart${number}.xml`
        }
      ])
    );
  }

  // Chart parts. Rendered by the XLSX writer's own `ChartSpaceXform` through the same helper it uses —
  // a chart part has no BIFF12 form, so this is a passthrough rather than a translation.
  for (const number of chartNumbers) {
    const entry = (chartEntries ?? {})[String(number)];
    if (entry === undefined) {
      continue;
    }
    addPart(
      `xl/charts/chart${number}.xml`,
      renderChartWithLeadingComments(entry as never, new ChartSpaceXform())
    );
  }

  // **`chartEx` parts, which were missing entirely.** The modern chart types — waterfall, funnel, treemap,
  // sunburst, histogram, box plot, region map — are `chartEx`, a different part with its own style and colour
  // sidecars and its own `.rels`. This writer emitted the *relationship* naming `../charts/chartEx1.xml` and
  // never the part, so Excel reported `Removed Part: /xl/drawings/drawingN.xml (Drawing shape)` and threw the
  // drawing away. Five of this repository's examples were affected across 39 dangling references, and the
  // package validator now refuses one (`package-dangling-relationship`) rather than leaving it to Excel.
  //
  // Assembled by the XLSX writer's own `addChartExEntries`, rerouted to collect parts instead of writing them —
  // the rules about byte-preserving a loaded chart, patching an edited one and numbering its relationships stay
  // in one place.
  for (const part of await XLSX.collectChartExParts(model as never)) {
    addPart(part.name, part.data);
  }
  if (sharedStrings) {
    addPart("xl/sharedStrings.bin", sharedStrings);
  }
  if (styles) {
    addPart("xl/styles.bin", styles);
  }
  for (const theme of themes) {
    addPart(theme.path, theme.xml);
  }

  for (const part of opaqueParts) {
    // A preserved part is arbitrary bytes and can be a VBA project or a media file — see `addPartAndDrain`.
    await addPartAndDrain(part.path, part.data);
    // A preserved part's own relationships travel with it, re-emitted rather than copied, so a
    // relationship pointing at something that was dropped does not survive as a dangling one.
    if (part.relationships && part.relationships.length > 0) {
      addPart(
        relationshipsPathFor(part.path),
        relationships(
          part.relationships.map(relationship => ({
            Id: relationship.id,
            Type: relationship.type,
            Target: relationship.target,
            ...(relationship.targetMode === undefined
              ? {}
              : { TargetMode: relationship.targetMode })
          }))
        )
      );
    }
  }

  // Last, so that it describes the package that exists.
  const hasVmlPart = partPaths.some(path => path.toLowerCase().endsWith(".vml"));
  sink.part(
    "[Content_Types].xml",
    contentTypes(
      partPaths,
      // Only the sheets that actually get a part — a chartsheet placeholder has none, and declaring a content type for
      // a part the package does not contain is the mirror image of writing a part nothing declares.
      sheetParts
        .filter((_part, index) => placeholderFor(index) === undefined)
        .map(part => part.path),
      sharedStrings !== undefined,
      styles !== undefined,
      opaqueDeclarations,
      // Image extensions get a `Default`, the way Excel declares them. Drawing parts get an `Override` each,
      // derived inside from `partPaths` rather than passed in — see the loop that writes them for why the two
      // are not the same set.
      media.contentTypes,
      themes.map(theme => theme.path),
      commentPaths,
      // **Any** VML part, not just a comment's. This asked `commentPaths.length > 0`, so a workbook whose only
      // VML is a header picture — a watermark — shipped `vmlDrawing1_hf.vml` with no content type declared for
      // its extension, and Excel refuses a package that contains a part it cannot type. Comments and header
      // pictures are two producers of the same extension, and only one of them was counted.
      hasVmlPart,
      tablePaths,
      threadedCommentSheetIds,
      persons.length > 0,
      chartNumbers,
      chartsheetParts.map(entry => entry.path),
      {
        tables: pivotViewPlans.map(plan => plan.tablePath),
        definitions: pivotCachePlans.map(plan => plan.definitionPath),
        records: pivotCachePlans.map(plan => plan.recordsPath)
      }
    )
  );

  // **A part written twice is reported**, because only one copy reached the package and the other is gone.
  //
  // Not a policy about which to keep — see `addPart` — but a statement that the writer produced two things for one name.
  // It happened once for real (a preserved chart and a new one both claiming `chart1.xml`, the preserved one dropped and
  // its drawing left pointing at the replacement) and nothing said so, because the reader is happy to read whichever
  // copy is present.
  for (const path of new Set(collisions)) {
    unsupported.push(`${path}: written twice, one copy dropped`);
  }

  // A caller that supplied its own sink owns the output — there is nothing to return but the report. The
  // default case assembles an archive here, which is what every existing caller expects.
  return {
    bytes: sink instanceof ArchiveSink ? await sink.bytes() : new Uint8Array(0),
    unsupported
  };
}

function relationships(entries: readonly { Id: string; Type: string; Target: string }[]): string {
  const writer = new XmlWriter();
  new RelationshipsXform().render(writer, [...entries]);
  return writer.xml;
}

function contentTypes(
  /**
   * Every path the package actually contains.
   *
   * Derived from what was written rather than from a per-feature list, which is the same reason
   * `[Content_Types].xml` is generated last: a declaration list built from predictions is a list that can
   * disagree with the package. The `chartEx` parts are declared from this.
   */
  allPartPaths: readonly string[],
  sheetPaths: readonly string[],
  hasSharedStrings: boolean,
  hasStyles: boolean,
  opaque: { overrides: Record<string, string>; defaults: Record<string, string> },
  imageTypes: ReadonlyMap<string, string>,
  themePaths: readonly string[],
  commentPaths: readonly string[],
  hasVml: boolean,
  tablePaths: readonly string[],
  threadedCommentSheetIds: readonly number[],
  hasPersons: boolean,
  chartNumbers: readonly number[],
  chartsheetPaths: readonly string[],
  pivotPaths: {
    readonly tables: readonly string[];
    readonly definitions: readonly string[];
    readonly records: readonly string[];
  }
): string {
  const raw = new XmlWriter();
  // **One `Override` per part name, enforced at the sink rather than at the twenty call sites below.**
  //
  // OPC forbids a repeated part name and LibreOffice rejects the package for it, so this is a correctness guard and not
  // tidiness. The duplicates arose the same way the duplicated *parts* did (see `addPart`): a workbook read from XLSB
  // hands its charts, drawings and tables over as preserved parts, which declare their own content type, and the writer
  // that owns each kind then declares it again. Sixteen on `sales-dashboard`, and no test saw them.
  //
  // Wrapping the writer keeps every existing call site honest by construction, including any added later — the
  // alternative is a `Set` check repeated twenty times, which is twenty chances to forget.
  const declared = new Set<string>();
  const writer = {
    openXml: (options: Parameters<XmlWriter["openXml"]>[0]) => raw.openXml(options),
    openNode: (name: string, attributes?: Record<string, string>) => raw.openNode(name, attributes),
    closeNode: () => raw.closeNode(),
    leafNode: (name: string, attributes?: Record<string, string>) => {
      const partName = name === "Override" ? attributes?.["PartName"] : undefined;
      if (partName !== undefined) {
        // Case-insensitively, because OPC part names are.
        const key = partName.toLowerCase();
        if (declared.has(key)) {
          return;
        }
        declared.add(key);
      }
      raw.leafNode(name, attributes);
    },
    get xml(): string {
      return raw.xml;
    }
  };
  writer.openXml({ version: "1.0", encoding: "UTF-8", standalone: "yes" });
  writer.openNode("Types", {
    xmlns: "http://schemas.openxmlformats.org/package/2006/content-types"
  });
  // `bin` as a Default, the way Excel declares it, with the workbook's own type. Every other `.bin`
  // part then carries an Override — which is what the worksheet entries below are.
  writer.leafNode("Default", { Extension: "bin", ContentType: WORKBOOK_CONTENT_TYPE });
  writer.leafNode("Default", {
    Extension: "rels",
    ContentType: "application/vnd.openxmlformats-package.relationships+xml"
  });
  writer.leafNode("Default", { Extension: "xml", ContentType: "application/xml" });
  for (const [extension, contentType] of imageTypes) {
    writer.leafNode("Default", { Extension: extension, ContentType: contentType });
  }
  for (const path of themePaths) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: "application/vnd.openxmlformats-officedocument.theme+xml"
    });
  }
  // **Derived from the package, not from the list of drawings this writer planned.** Those are not the same
  // set: a chartsheet's drawing is written straight through `addPart` with a literal path and never joins the
  // `drawings` array, so six `chartsheetDrawing*.xml` parts went out described by the `Default xml` above as
  // `application/xml`. Excel's answer was six of `Removed Part: Drawing shape.` — a drawing it will not read
  // as a drawing is a drawing it discards, and the charts anchored in them went with it.
  //
  // This is the third time the same mistake has been paid for here: the `chartEx` sidecars and the theme were
  // both missing for the same reason, that a declaration list was maintained beside the thing it describes
  // rather than read off it. A part in `xl/drawings/` *is* a drawing whoever wrote it, so scanning
  // `allPartPaths` closes the gap for every future producer at once instead of one at a time.
  for (const path of allPartPaths.filter(candidate =>
    /^xl\/drawings\/[^/]+\.xml$/.test(candidate)
  )) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: "application/vnd.openxmlformats-officedocument.drawing+xml"
    });
  }
  // A chartsheet is a `.bin` and so already covered by the `Default` above — with the *worksheet's* type,
  // which would describe it as a cell grid. It needs an `Override` for the same reason a comments part
  // does.
  for (const path of chartsheetPaths) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: CHARTSHEET_CONTENT_TYPE });
  }

  // A chart part is XML in both containers — `cal-any_sheets.xlsb` carries `xl/charts/chart1.xml` beside
  // a `.bin` chartsheet — so its type is the XLSX one verbatim.
  for (const number of chartNumbers) {
    writer.leafNode("Override", {
      PartName: `/xl/charts/chart${number}.xml`,
      ContentType: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
    });
  }

  // **`chartEx` and its two sidecars, which had no content type at all.** Every `chartEx*.xml`,
  // `styleEx*.xml` and `colorsEx*.xml` fell through to the package's `Default` for `xml`, which is
  // `application/xml` — so Excel could not tell a chartEx from an arbitrary XML document, could not resolve the
  // `graphicFrame` that pointed at it, and answered `Removed Part: /xl/drawings/drawingN.xml (Drawing shape)`.
  //
  // The XLSX writer's own content-type code carries a comment describing that exact cascade, and the exact
  // lowercase spelling Excel 2016+ requires (`chartex`, not `chartEx`). This part of the XLSB writer simply
  // never had the logic: the `chartEx` parts were added to the package a few rounds ago and their declarations
  // were not. The type strings come from `CHART_EX_CONTENT_TYPES` so the two writers cannot drift.
  //
  // Note this is invisible to a "does every part have a content type?" check — `Default xml` answers yes for all
  // three. Having *a* content type is not the same as having the right one.
  for (const part of allPartPaths) {
    const contentType = CHART_EX_CONTENT_TYPES.find(entry => entry.test.test(part))?.type;
    if (contentType !== undefined) {
      writer.leafNode("Override", { PartName: `/${part}`, ContentType: contentType });
    }
  }

  // Threaded comments and the person list are **XML in both containers** — there is no BIFF12 form of
  // either — so their types are the XLSX ones verbatim.
  for (const sheetId of threadedCommentSheetIds) {
    writer.leafNode("Override", {
      PartName: `/xl/threadedComments/threadedComment${sheetId}.xml`,
      ContentType: "application/vnd.ms-excel.threadedcomments+xml"
    });
  }
  if (hasPersons) {
    writer.leafNode("Override", {
      PartName: "/xl/persons/person.xml",
      ContentType: "application/vnd.ms-excel.person+xml"
    });
  }

  // A comments part is a `.bin` and therefore already covered by the `Default` above — with the *wrong*
  // type, the workbook's. It needs an `Override` for the same reason every worksheet does.
  for (const path of commentPaths) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: COMMENTS_CONTENT_TYPE });
  }
  // A table part is a `.bin` too, so it needs an `Override` for the same reason a comments part does.
  for (const path of tablePaths) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: TABLE_CONTENT_TYPE });
  }
  // The three pivot parts, each a `.bin` with its own type. A missing `Override` here leaves the part
  // described as a workbook by the `Default`, which is how a pivot table becomes a repair prompt.
  for (const path of pivotPaths.tables) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: PIVOT_TABLE_CONTENT_TYPE });
  }
  for (const path of pivotPaths.definitions) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: PIVOT_CACHE_DEFINITION_CONTENT_TYPE
    });
  }
  for (const path of pivotPaths.records) {
    writer.leafNode("Override", {
      PartName: `/${path}`,
      ContentType: PIVOT_CACHE_RECORDS_CONTENT_TYPE
    });
  }
  // Legacy VML carries its own extension, declared as a `Default` the way Excel does it. Only when
  // something actually uses it: an unused `Default` describes a part the package does not contain.
  if (hasVml) {
    writer.leafNode("Default", {
      Extension: "vml",
      ContentType: "application/vnd.openxmlformats-officedocument.vmlDrawing"
    });
  }

  for (const path of sheetPaths) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: WORKSHEET_CONTENT_TYPE });
  }
  if (hasSharedStrings) {
    writer.leafNode("Override", {
      PartName: "/xl/sharedStrings.bin",
      ContentType: SHARED_STRINGS_CONTENT_TYPE
    });
  }
  if (hasStyles) {
    writer.leafNode("Override", {
      PartName: "/xl/styles.bin",
      ContentType: STYLES_CONTENT_TYPE
    });
  }
  writer.leafNode("Override", {
    PartName: "/docProps/core.xml",
    ContentType: "application/vnd.openxmlformats-package.core-properties+xml"
  });
  writer.leafNode("Override", {
    PartName: "/docProps/app.xml",
    ContentType: "application/vnd.openxmlformats-officedocument.extended-properties+xml"
  });
  for (const [extension, contentType] of Object.entries(opaque.defaults)) {
    writer.leafNode("Default", { Extension: extension, ContentType: contentType });
  }
  for (const [path, contentType] of Object.entries(opaque.overrides)) {
    writer.leafNode("Override", { PartName: `/${path}`, ContentType: contentType });
  }
  writer.closeNode();
  return writer.xml;
}

/**
 * Preserved parts that something still points at.
 *
 * A part reachable only from a sheet that has since been deleted is dropped rather than written
 * back, because an unreferenced part is one of the things Excel offers to repair. The reachability
 * check is the same one `xlsx/` uses.
 */
function reachableOpaqueParts(
  model: WorkbookModel,
  sheetParts: readonly {
    readonly path: string;
    readonly opaqueRels: readonly OpaqueRelationship[];
  }[]
): { readonly parts: readonly OpaquePart[]; readonly drops: readonly string[] } {
  // **Sheet parts from the other container do not travel.** An XLSX read preserves `xl/worksheets/sheetN.xml` only
  // when this library could not model it, and a SpreadsheetML sheet is not a BIFF12 record stream — see
  // `isForeignSheetPart`. Filtered before reachability rather than after, so the chain hanging off such a part is
  // resolved against a package that no longer contains it.
  const all = model.opaqueParts ?? [];
  const foreign = all.filter(part => isForeignSheetPart(part, "xlsb"));
  const parts = foreign.length === 0 ? all : all.filter(part => !isForeignSheetPart(part, "xlsb"));
  if (parts.length === 0) {
    return {
      parts: [],
      drops: foreign.map(part => `${part.path}: preserved sheet part from the other container`)
    };
  }
  // The relationships **this write will actually emit** — not every relationship the model remembers.
  // Passing the latter made the filter vacuous: a part reached only from a deleted worksheet counted
  // its own historical inbound edge as evidence that something still pointed at it, so it was written
  // and then nothing did. An orphan part is precisely what this filter exists to prevent, and it was
  // producing them.
  const emitted: OpaqueSourceRelationship[] = [];
  for (const part of parts) {
    for (const inbound of part.sourceRelationships ?? []) {
      // The root and the workbook are re-emitted wholesale by `appendOpaqueSourceRelationships`, so their edges
      // survive whatever happened to the sheets. Both containers' spellings count — see `isRootOrWorkbookSourced`.
      if (isRootOrWorkbookSourced(inbound)) {
        emitted.push(inbound);
      }
    }
  }
  // A surviving sheet's edges travel with the sheet rather than with its old path: the sheet may be
  // written at a different `sheetN.bin` than it was read from. The targets are relative and resolve
  // identically from any sheet path, which is why re-basing them onto the new one is sound.
  for (const part of sheetParts) {
    for (const relationship of part.opaqueRels) {
      emitted.push({ ...relationship, source: part.path });
    }
  }
  const resolved = resolveReachableOpaqueParts(parts, emitted);
  return {
    parts: resolved.parts,
    // **Only one of the two kinds of drop is a loss, and putting both here was a category error.**
    //
    // A part from the *other container's* sheet family is content this writer cannot express: an XLSB chartsheet has no
    // form in a SpreadsheetML package, so the tab is genuinely gone and the caller needs telling. That belongs in
    // `unsupported` beside everything else this writer cannot carry.
    //
    // An **unreachable** part is the opposite. Nothing in the written package points at it, and removing it is the
    // documented purpose of the filter — a deleted sheet taking its drawing with it is correct behaviour, not damage.
    // Reporting it as unsupported made the *default* policy refuse a perfectly good workbook: a preserved
    // `theme2.xml` that lost its referrer turned `Workbook.toBuffer` into a rejection. So it stays unreported here,
    // which is also why `OpaqueDropReason` is documented as a read-time vocabulary.
    drops: foreign.map(part => `${part.path}: preserved sheet part from the other container`)
  };
}

/**
 * Page setup and sheet defaults from a worksheet model.
 *
 * Only the fields whose `BrtPageSetup` / `BrtMargins` / `BrtWsFmtInfo` layouts the reference corpus
 * establishes are carried. `BrtPrintOptions` is not among them: two bytes, and the corpus reads
 * `0x0010` in most workbooks but `0x5950` and `0x5a30` in one — a field of about six flags should
 * not reach 0x5a30, so either the reading is wrong or those records are something else. A print
 * option guessed wrong flips a boolean nobody notices, so it is left out rather than approximated.
 */

/**
 * Render an XLSX xform to a string, for the two document-property parts XLSB shares with it.
 *
 * The xforms are typed against their own models, and the workbook model satisfies both structurally
 * — so the cast is at this boundary rather than spread through the call sites.
 */
function renderXform(
  xform: { render: (writer: XmlWriter, model: never) => void },
  model: WorkbookModel
): string {
  const writer = new XmlWriter();
  (xform.render as (writer: XmlWriter, model: WorkbookModel) => void)(writer, model);
  return writer.xml;
}

/**
 * The first candidate `format(n)` that `taken` rejects, starting at `from`.
 *
 * Shared by the drawing-part namer and the media namer because both are the same question — "what
 * would Excel call this, and is that name already occupied?" — and both answers have to hold against
 * parts this writer did not create.
 */
function unusedName(
  taken: (candidate: string) => boolean,
  format: (n: number) => string,
  from: number
): string {
  let n = from;
  while (taken(format(n))) {
    n++;
  }
  return format(n);
}

/**
 * The `_xlfn.*` defined names a workbook's formulas will need, in the shape `BrtName` writes.
 *
 * A function with no `Ftab` id — `XLOOKUP`, `TEXTJOIN`, `CONFIDENCE.T`, anything newer than the enumeration —
 * is called through a `PtgName` naming a hidden stub, which is Excel's own mechanism and the only way such a
 * call can be written at all. Those calls used to be refused by name.
 *
 * **Collected by scanning the formula text, not while encoding.** A `PtgName` is a one-based index into the
 * defined-name list, and the list is counted before any formula is encoded; a stub created mid-encoding would
 * be given an index the file does not have. The scan is a regular expression over the formula source rather
 * than a parse, deliberately: a name that turns out not to be needed costs one hidden defined name, while a
 * missed one costs the formula. Over-collecting is the safe direction.
 *
 * Existing names win. A workbook that already defines `_xlfn.XLOOKUP` — because it was read from a file Excel
 * had repaired — gets no second copy.
 */
function futureFunctionStubs(
  worksheets: WorkbookModel["worksheets"],
  existing: readonly { readonly name: string }[]
): { readonly name: string; readonly formula: string; readonly hidden: boolean }[] {
  const already = new Set(existing.map(entry => entry.name));
  const wanted = new Map<string, string>();
  for (const worksheet of worksheets) {
    for (const row of worksheet.rows ?? []) {
      for (const cell of row.cells ?? []) {
        const formula = (cell as { formula?: unknown }).formula;
        if (typeof formula !== "string") {
          continue;
        }
        // A function call in the source is a name followed by `(`. `_xlfn.`-prefixed names are skipped: they
        // are already stubs, and prefixing one again would produce `_xlfn._xlfn.X`.
        for (const match of formula.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
          const name = match[1]!;
          if (name.startsWith("_xlfn.") || !isFutureFunction(name)) {
            continue;
          }
          const stub = futureFunctionStubName(name);
          if (!already.has(stub)) {
            wanted.set(stub, name);
          }
        }
      }
    }
  }
  // `formula` is the text form of `PtgErr(#NAME?)`, which is the body Excel gives every stub. The record
  // writer re-encodes it, so the two agree by construction rather than by a second literal.
  return [...wanted.keys()].map(name => ({ name, formula: "#NAME?", hidden: true }));
}

/**
 * Modelled themes, as parts to write.
 *
 * A theme reaches this writer one of three ways and they must not both fire. An XLSB read leaves it in
 * `opaqueParts` and it is written back verbatim; an XLSX read parses it into `model.themes`, and until
 * now nothing wrote that — so a converted workbook kept its `{ theme: n }` colours and lost the table
 * they resolve through. The reservation check is what keeps a preserved theme from being written twice
 * when a model somehow carries both.
 *
 * The third way is the built-in theme, and it exists because a workbook *built from scratch* has
 * neither of the other two: `model.themes` is undefined and there is nothing to preserve. The XLSX
 * writer has always defaulted in that case (`model.themes || { theme1: theme1Xml }`), so the same
 * model written to the two formats disagreed about whether a theme exists at all — and the XLSB was
 * the one that shipped dangling references. A theme slot is named, not inlined: every `{ theme: n }`
 * cell colour, every `<a:schemeClr>` in a chart sidecar and every `majorFont`/`minorFont` in a chart
 * style resolves through `xl/theme/theme1.xml`, so a package that omits the part while referencing it
 * is not merely plainer-looking — it is unresolvable, and Excel repairs it.
 *
 * `reservedPaths` is not a sufficient guard on its own here: a preserved theme is free to be named
 * `theme2.xml`, which would not collide with the default's path and would leave the workbook carrying
 * two themes. So the default is suppressed by the presence of *any* preserved theme, not by its name —
 * and by one that survives the reachability filter, since a dropped part suppressing the fallback
 * yields a package with no theme whatsoever.
 */
function themeParts(
  model: WorkbookModel,
  reservedPaths: Set<string>,
  writtenOpaqueParts: readonly { readonly path: string }[]
): readonly { readonly path: string; readonly xml: string }[] {
  const modelled = model.themes as Record<string, string> | undefined;
  const preserved = writtenOpaqueParts.some(part =>
    part.path.toLowerCase().startsWith("xl/theme/")
  );
  const themes = modelled ?? (preserved ? undefined : { theme1: theme1Xml });
  if (themes === undefined) {
    return [];
  }
  const parts: { path: string; xml: string }[] = [];
  for (const [name, xml] of Object.entries(themes)) {
    if (typeof xml !== "string") {
      continue;
    }
    const path = themePath(name);
    if (reservedPaths.has(path.toLowerCase())) {
      continue;
    }
    reservedPaths.add(path.toLowerCase());
    parts.push({ path, xml });
  }
  return parts;
}

/**
 * The `BrtDrawing` a sheet should carry: the modelled drawing's id, or the one it was read with.
 *
 * Only one of the two can apply. A sheet with modelled images gets a freshly written drawing part and
 * therefore a fresh id; a sheet whose images this reader preserved as opaque parts keeps the id that
 * still points at them. A sheet with *both* is the case `drawingForWorksheet` refuses.
 */
function drawingReference(
  worksheet: WorkbookModel["worksheets"][number],
  drawing: DrawingPart | undefined
): { drawingRelationshipId?: string } {
  if (drawing !== undefined) {
    return { drawingRelationshipId: drawing.rId };
  }
  const preserved = worksheet.xlsbDrawingRelationshipId;
  return preserved === undefined ? {} : { drawingRelationshipId: preserved };
}

/** A drawing part and the sheet relationship that reaches it. */
interface DrawingPart {
  readonly name: string;
  readonly rId: string;
  // The shapes `drawing-utils` produces and `DrawingXform` consumes, named rather than widened to
  // `unknown[]`. The casts that widening required — `as unknown as Parameters<…>[0]` going in and
  // `as never` going out — meant a change to the XLSX drawing model could not fail to compile here; it
  // would fail at runtime, in a package, on a picture.
  anchors: DrawingAnchor[];
  rels: DrawingRel[];
}

/**
 * The drawing a worksheet needs for its images, or `undefined` when it has none.
 *
 * The anchor arithmetic and the relationship bookkeeping come from `buildDrawingAnchorsAndRels`,
 * which the XLSX path uses for the same job — a second implementation of "where on the sheet does
 * this picture sit" would be a second thing to keep in step, and the one with fewer users would be
 * the one that drifted.
 */
function drawingForWorksheet(
  worksheet: WorkbookModel["worksheets"][number],
  namedMedia: readonly MediaLike[],
  index: number,
  accumulated: DrawingPart[],
  reservedPaths: Set<string>,
  usable: ReadonlySet<number>,
  losses: string[]
): DrawingPart | undefined {
  const media = (worksheet.media ?? []).filter(
    medium => medium.type === "image" && usable.has(Number(medium.imageId))
  );
  const watermarks = (worksheet.media ?? []).filter(
    medium => medium.type === "watermark" && usable.has(Number(medium.imageId))
  );
  // User-drawn shapes share the sheet's one drawing part with its pictures — a shape is an anchor beside
  // them, not a part of its own, which is why `BrtDrawing` is a single relationship id. So a sheet with
  // shapes and no images still needs the drawing.
  //
  // **Written, and read back as an opaque part rather than as shapes.** That is the same asymmetry
  // pictures already have: the drawing is XML, this reader does not model drawings, and it preserves the
  // part verbatim — so a read-modify-write keeps every shape byte for byte and `Image.getShapes` on the
  // reopened workbook returns nothing. The shapes are in the file and Excel draws them; what is absent is
  // the *model* of them, which is a drawing-reader feature rather than a writer one.
  const shapes = ((worksheet as unknown as { shapes?: readonly ShapeLike[] }).shapes ?? []).filter(
    shape => shape.anchorRange !== undefined
  );
  // Form controls need the drawing too, and for a reason worth stating: their DrawingML anchors are
  // *hidden bridges* to the VML shapes that draw them. Excel writes one when it repairs a sheet with
  // legacy controls and no `<drawing>` part, so a sheet with controls and nothing else still needs it.
  const formControls = (
    (worksheet as unknown as { formControls?: readonly FormControlLike[] }).formControls ?? []
  ).filter(control => control.tl !== undefined && control.br !== undefined);
  // Charts are anchors in the same drawing, reached from it by a relationship the `graphicFrame` names.
  const charts = (
    (worksheet as unknown as { charts?: readonly ChartAnchorLike[] }).charts ?? []
  ).filter(chart => (chart.chartNumber ?? 0) > 0 || (chart.chartExNumber ?? 0) > 0);
  if (
    media.length === 0 &&
    watermarks.length === 0 &&
    shapes.length === 0 &&
    formControls.length === 0 &&
    charts.length === 0
  ) {
    return undefined;
  }
  // **A sheet has at most one drawing.** Every picture, chart and shape on it is an anchor inside that
  // one part, which is why `BrtDrawing` is a single id rather than a collection. So a sheet that already
  // carries a preserved drawing and has new modelled images cannot have both: the sheet gets one
  // `BrtDrawing`, and whichever drawing it does not name becomes unreachable — the preserved pictures
  // silently vanish.
  //
  // Merging would need the preserved drawing's XML parsed and its anchors rewritten, and this reader
  // deliberately does not model drawings. So the combination is refused and named instead. Under
  // `"ignore"` the *preserved* drawing wins: the caller asked to add a picture, not to delete the ones
  // already there.
  if (worksheet.xlsbDrawingRelationshipId !== undefined) {
    losses.push(
      `${media.length + shapes.length} new image(s) or shape(s) on a sheet that already has a ` +
        `preserved drawing, which this writer cannot merge into`
    );
    return undefined;
  }
  // A name no preserved part already occupies. `drawing${index + 1}` is what Excel would call it, but
  // a workbook *read from XLSB* keeps its original drawings as opaque parts — this reader does not
  // model them — so adding an image to a sheet that already had one produced a second
  // `xl/drawings/drawing1.xml` at the same path as the preserved one. One of the two then won,
  // depending on how the container treats a duplicate entry.
  const name = unusedName(
    candidate => reservedPaths.has(drawingPath(candidate).toLowerCase()),
    base => `drawing${base}`,
    index + 1
  );
  // An id nothing else in this sheet's `.rels` uses. `rId1` unconditionally was safe only while the
  // sheet had no other relationships; a preserved relationship carried through from a read is free
  // to be `rId1` itself, and two entries with one id is a malformed part.
  const takenIds = new Set((worksheet.opaqueRels ?? []).map(relationship => relationship.id));
  const rId = unusedName(
    candidate => takenIds.has(candidate),
    base => `rId${base}`,
    1
  );
  // Claimed immediately. Only the *preserved* paths were consulted before, so two sheets adding an image
  // to a package that already had `drawing1` both looked past it, both landed on `drawing2`, and the
  // archive received one path twice.
  reservedPaths.add(drawingPath(name).toLowerCase());
  const drawing: DrawingPart = { name, rId, anchors: [], rels: [] };
  const built = buildDrawingAnchorsAndRels(media as ImageMedium[], [], {
    getBookImage: id => namedMedia[Number(id)],
    nextRId: rels => `rId${rels.length + 1}`
  });
  drawing.anchors = built.anchors;
  drawing.rels = built.rels;
  // After the images, so a shape's `cNvPrId` cannot collide with a picture's — image and chart ids derive
  // from their anchor position, and a shape numbering itself from 1 would land on the first picture.
  // Overlay watermarks, before the shapes for the same id-space reason and after the pictures because they
  // are pictures — the same `buildImageRel` bookkeeping, and the same drawing part.
  drawing.anchors.push(
    ...buildWatermarkOverlayAnchors(
      watermarks as { imageId: string | number; opacity?: number }[],
      {
        getBookImage: id => namedMedia[Number(id)],
        nextRId: rels => `rId${rels.length + 1}`,
        extent: { right: worksheet.dimensions?.right, bottom: worksheet.dimensions?.bottom }
      },
      drawing.rels
    )
  );
  drawing.anchors.push(...buildShapeAnchors(shapes, drawing.anchors.length));
  drawing.anchors.push(...buildFormControlAnchors(formControls, drawing.anchors.length));
  // After the rest, so a chart's relationship id follows the images' in the drawing's own id space.
  drawing.anchors.push(...buildChartAnchors(charts, drawing.rels));
  accumulated.push(drawing);
  return drawing;
}

/**
 * Everything the package needs to know about its images, decided once.
 *
 * **Why one pass rather than three.** The part path, the content type and the relationship target
 * each used to derive the filename independently, and they disagreed: the archive wrote
 * `image1.png` for a medium with no `extension`, while the content-type scan skipped that medium
 * because it had none — so the part was written and never declared. Deriving all three from one
 * resolved list makes that class of mismatch unrepresentable.
 */
interface MediaPlan {
  /**
   * The media in model order, each with a name.
   *
   * A *copy*. `addWorkbookImage` deliberately leaves the name unset — a name is a fact about the
   * package, not about the image — so a writer has to assign one, and this writer used to do that by
   * assigning onto the caller's own media objects. That made `Workbook.toBuffer` mutate its input,
   * including on the path where it then rejected the workbook as unsupported.
   */
  readonly named: readonly MediaLike[];
  /** The parts to write, already resolved to bytes. */
  readonly parts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** Content type per extension, for the `Default` declarations. */
  readonly contentTypes: ReadonlyMap<string, string>;
  /**
   * Media indices that reached the package — as a part, or as an external link.
   *
   * A drawing may only reference these. `ImageData` makes all four byte sources optional, so
   * `Image.add(workbook, { extension: "png" })` type-checks, and it used to produce a drawing
   * relationship pointing at `../media/imageN.png` with no such part written: a dangling reference,
   * which Excel offers to repair. Filtering the anchors is what makes the reference and the part
   * agree; `losses` is what stops the omission being silent.
   */
  readonly usable: ReadonlySet<number>;
  /** Media this writer could not embed, as `name: reason`. */
  readonly losses: readonly string[];
}

/**
 * Resolve every image to a name, a part and a content type.
 *
 * Async because a medium may name a file rather than carry its bytes. That form is part of the
 * public `ImageData`, and this writer previously ignored it: the drawing relationship was still
 * emitted, so the package came out with `../media/imageN.png` pointing at a part that was never
 * written — a dangling reference, which is one of the things Excel offers to repair. In a browser
 * `readFileBytes` throws, which is the same outcome the XLSX path produces for a filename it
 * cannot read, and a great deal better than a silently broken package.
 */
async function planMedia(
  model: WorkbookModel,
  reservedPaths: ReadonlySet<string>
): Promise<MediaPlan> {
  const named: MediaLike[] = [];
  const parts: { path: string; bytes: Uint8Array }[] = [];
  const contentTypes = new Map<string, string>();
  const usedPaths = new Set(reservedPaths);
  const usable = new Set<number>();
  const losses: string[] = [];

  const media = model.media ?? [];
  for (const [index, medium] of media.entries()) {
    if (medium.type !== "image") {
      named.push(medium as MediaLike);
      continue;
    }
    const extension =
      typeof medium.extension === "string" && medium.extension.length > 0
        ? medium.extension.toLowerCase()
        : "png";
    // The name the relationship target is built from, so the two cannot disagree — and one nothing else
    // in the package already occupies.
    //
    // An *explicit* name goes through the same check, which it did not before: two media both named
    // `logo` produced one `xl/media/logo.png` and two drawings pointing at it, so the second picture
    // silently became a copy of the first. A name is a request, and the package can only honour it once.
    const taken = (candidate: string): boolean =>
      usedPaths.has(mediaPath(`${candidate}.${extension}`).toLowerCase());
    const requested = medium.name;
    const name =
      requested !== undefined && !taken(requested)
        ? requested
        : unusedName(
            taken,
            base => `${requested ?? "image"}${base}`,
            requested === undefined ? index + 1 : 2
          );
    usedPaths.add(mediaPath(`${name}.${extension}`).toLowerCase());
    const entry: MediaLike = { ...(medium as MediaLike), name };
    named.push(entry);
    // An external image is referenced in place through `TargetMode="External"` and stores no bytes,
    // so it needs neither a part nor a content type.
    if (isExternalImage(entry)) {
      usable.add(index);
      continue;
    }
    const bytes = await mediaBytes(medium);
    if (bytes === undefined) {
      losses.push(`${name}: image with no bytes and no link`);
      continue;
    }
    usable.add(index);
    parts.push({ path: mediaPath(`${entry.name}.${extension}`), bytes });
    contentTypes.set(extension, imageContentTypeFor(extension));
  }

  return { named, parts, contentTypes, usable, losses };
}

/** An image's bytes, from whichever of the three embedded forms it carries. */
async function mediaBytes(medium: {
  buffer?: Uint8Array;
  base64?: string;
  filename?: string;
}): Promise<Uint8Array | undefined> {
  if (medium.buffer !== undefined) {
    return medium.buffer;
  }
  if (medium.base64 !== undefined) {
    // The `data:` prefix is optional in the model, so the payload is taken from the comma onwards.
    // Decoded through the shared helper rather than `Buffer`, which does not exist in a browser —
    // this writer is on the browser IO path, so a base64 image used to fail there with
    // `ReferenceError: Buffer is not defined` while the same workbook wrote fine under Node.
    return base64ToUint8Array(medium.base64.slice(medium.base64.indexOf(",") + 1));
  }
  if (medium.filename !== undefined) {
    return readFileBytes(medium.filename);
  }
  return undefined;
}

/**
 * A medium's path relative to a worksheet or a drawing, or `undefined` when it was not written.
 *
 * **The `imageId` indexes the *workbook's* media, not the sheet's.** A sheet's entry is a reference —
 * `{ type: "background", imageId: "0" }` — and the bytes, the extension and the name all live on the
 * workbook medium it points at, which `planMedia` has already written to `xl/media/`. Reading the name
 * off the sheet's own entry finds nothing, because it has none.
 *
 * `../media/…` is correct from both `xl/worksheets/` and `xl/drawings/`: they are siblings.
 */
function mediaTarget(
  imageId: string | number | undefined,
  named: readonly MediaLike[]
): string | undefined {
  if (imageId === undefined) {
    return undefined;
  }
  const index = Number(imageId);
  const entry = named[index];
  if (entry === undefined || entry.name === undefined) {
    return undefined;
  }
  const extension =
    typeof entry.extension === "string" && entry.extension.length > 0
      ? entry.extension.toLowerCase()
      : "png";
  return `../media/${entry.name}.${extension}`;
}
