/**
 * The worksheet part: `xl/worksheets/sheetN.bin`.
 *
 * The order of the records is Excel's own, and it is not cosmetic. A workbook this library wrote with
 * the sheet's *views* missing satisfied every structural rule its validator knew and Excel refused to
 * open it — a sheet with no view has nowhere to be displayed. So the sequence below mirrors nine
 * Excel-authored workbooks record for record, and `record-missing-required` in the validator is what
 * keeps it that way rather than this function's comments.
 */
import type { HeaderFooter, IgnoredError, Margins } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  COLUMN_WIDTH_UNITS,
  encodeBiffRecords,
  encodeCell,
  encodeNullableWideString,
  encodeRange,
  encodeWideString,
  type BiffRange
} from "@excel/xlsb/binary";
import {
  conditionalFormattingRecords,
  type SheetConditionalFormatting
} from "@excel/xlsb/conditional-format";
import {
  dataValidationHeader,
  encodeValidation,
  type SheetValidation
} from "@excel/xlsb/data-validation";
import {
  printOptions,
  type PrintOptionsLike,
  selection,
  sheetProtection,
  sheetProtectionIso,
  worksheetView,
  type SheetProtectionLike,
  type WorksheetViewLike
} from "@excel/xlsb/defaults";
import { encodeDrawing } from "@excel/xlsb/drawing";
import { encodeAutoFilter, encodeIgnoredError } from "@excel/xlsb/filter";
import { filterCriteriaRecords } from "@excel/xlsb/filter-criteria";
import type { PtgContext } from "@excel/xlsb/formula/ptg";
import { encodeHeaderFooter, hasHeaderFooter } from "@excel/xlsb/header-footer";
import { encodeBreak, type SheetBreak } from "@excel/xlsb/page-breaks";
import {
  encodeMargins,
  encodePageSetup,
  encodeSheetFormatInfo,
  type ReadPageSetup,
  type SheetFormatInfo
} from "@excel/xlsb/page-setup";
import { encodePane, paneSelections, type SheetPane } from "@excel/xlsb/pane";
import { encodeSheetProperties, type SheetProperties } from "@excel/xlsb/sheet-properties";
import { sparklineRecords, type SheetSparklineGroup } from "@excel/xlsb/sparkline";
import { DEFAULT_DATE_FORMAT, internStyle, type CellFormatTable } from "@excel/xlsb/styles";
import { encodeCellRecord, isRefused, usedRange } from "@excel/xlsb/write/cells";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { encodeRowHeader } from "@excel/xlsb/write/rows";
import type { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import { type SheetColumn, type SheetRow } from "@excel/xlsb/write/types";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

export interface WrittenWorksheet {
  readonly bytes: Uint8Array;
  /**
   * Cells whose content could not be expressed, as `A1: reason`.
   *
   * Collected here rather than classified before serialisation, because whether a formula
   * can be encoded is not knowable from the model — it depends on the tokens it needs and on
   * whether the workbook defines the names it references. An earlier version decided up
   * front and therefore reported nothing when the encoder later refused, which is precisely
   * the silent loss the report exists to prevent.
   */
  readonly unsupported: readonly string[];
}

/**
 * Everything `writeWorksheetPart` needs.
 *
 * **One options object, not seven parameters.** This grew to six positional arguments plus a bag, which
 * is the shape a function takes when each new capability is appended rather than placed: nothing at the
 * call site said which of `merges` and `columns` came first, and a caller that wanted only the last
 * option had to supply five defaults to reach it. Every input is now named at the call site, and adding
 * one is a field rather than a decision about ordering.
 *
 * Named rather than left inline so a caller — the package assembler, a test, a future streaming writer
 * — can refer to the contract instead of reaching for `Parameters<typeof writeWorksheetPart>[0]`, and
 * so the two fields with a lifetime beyond one call have somewhere to say so.
 */
export interface WriteWorksheetPartOptions {
  /** Rows in any order; they are sorted here, because the format requires ascending row numbers. */
  readonly rows: readonly SheetRow[];
  /**
   * Omit `BrtWsDim`, for a caller that does not have the sheet's extent yet.
   *
   * The record states the used range and sits *before* the rows, so a single forward pass over rows cannot fill
   * it in — which is the one thing that stopped an XLSB sheet part from being produced incrementally. The XLSX
   * side has the same problem and omits `<dimension>` for the same reason; `stream/worksheet-writer.ts` carries
   * a note saying Excel cannot handle it at the end of the file.
   *
   * **Verified rather than assumed.** A package with the record removed from every sheet opens in Excel without
   * a repair, which is the only authority that counts here — Excel writes `BrtWsDim` in all 67 worksheet parts
   * across the corpus, so its absence is unobserved in the reference material and nothing but Excel could settle
   * it.
   *
   * Off by default on purpose. The buffered writer has the extent for free and there is no reason for its output
   * to differ from Excel's; only a streaming caller takes this liberty, and only because it cannot do otherwise.
   */
  readonly omitDimension?: boolean;
  /**
   * Regions that occupy the grid without contributing cell records, widening `BrtWsDim`.
   *
   * A pivot table's output is the case: its body is Excel's to render, so nothing here writes a cell for it, and a
   * dimension derived from rows alone said `0..0` — an empty sheet — for all three pivot sheets in `05-pivots`. Excel
   * never writes `0..0`: 21 of 21 records across the reference workbooks state a real extent.
   */
  readonly occupiedRegions?: readonly BiffRange[];
  /**
   * Interned strings, filled as the cells are written and serialised by the caller afterwards.
   *
   * Required, like `formats`, because it is *shared across sheets*: the caller owns it, passes the same
   * one to every sheet and writes `sharedStrings.bin` from it at the end.
   */
  readonly strings: SharedStringTable;
  /** What a formula's sheet and name references resolve against. */
  readonly formulaContext?: PtgContext;
  /**
   * Cell formats, interned as the cells are written.
   *
   * Required for the same reason `strings` is, and it was optional — defaulting to a fresh table
   * this function then kept to itself. Any sheet with a style therefore wrote non-zero style indices
   * into a table the caller never received and could not serialise, so the part came out referring to
   * `styles.bin` entries that would not exist. An optional argument whose default cannot produce a
   * consistent package is not a convenience.
   */
  readonly formats: CellFormatTable;
  readonly merges?: readonly BiffRange[];
  readonly columns?: readonly SheetColumn[];
  /** Paper, scaling, orientation and margins. */
  /**
   * What the sheet's print records say, in the model's terms.
   *
   * **`PrintOptionsLike` is part of this and was missing.** `BrtPageSetup` and `BrtPrintOptions` are two records
   * and one object in the model, and typing this as `ReadPageSetup` alone — the fields of the first record only —
   * silently narrowed the four print options away before the writer could see them. So `horizontalCentered` was
   * set on the sheet, present in the model, and gone by the time it reached `printOptions()`.
   */
  readonly pageSetup?: ReadPageSetup & PrintOptionsLike & { readonly margins?: Partial<Margins> };
  /** Default row height and column width. */
  readonly formatInfo?: SheetFormatInfo;
  /** Tab colour and VBA code name. */
  readonly sheetProperties?: SheetProperties;
  /**
   * Relationship id of the sheet's drawing part, when it has one.
   *
   * The part itself is XML and shared with the XLSX path; only this reference is binary.
   */
  readonly drawingRelationshipId?: string;
  /**
   * Relationship ids of this sheet's table parts, in order.
   *
   * **A table part that nothing points at is a table Excel does not show.** The part, its content type and
   * its relationship were all written and the sheet never named them, so the table was in the package and
   * absent from the sheet — the one shape of defect a package validator cannot see, because every part it
   * checks is present and well-formed.
   */
  readonly tableRelationshipIds?: readonly string[];
  /** What the sheet prints at the top and bottom of each page. */
  readonly headerFooter?: Partial<HeaderFooter>;
  /**
   * Hyperlinks, each already paired with the relationship id that will name its destination.
   *
   * The id is decided by the package assembler, because the destination is an entry in this sheet's
   * `.rels` and the assembler is what writes that file. `BrtHLink` carries only the reference.
   */
  readonly hyperlinks?: readonly {
    readonly row: number;
    readonly column: number;
    readonly relationshipId: string;
    /** Set for a link within the workbook, which carries its destination here and has no relationship. */
    readonly location?: string;
  }[];
  /**
   * Relationship id of the VML holding the comment boxes.
   *
   * Without a `BrtLegacyDrawing`, Excel opens a workbook whose `comments{N}.bin` is present and correct
   * and shows nothing — the record is what connects the note text to the box that displays it. Both
   * corpus workbooks that carry comments carry this record too.
   */
  readonly legacyDrawingRelationshipId?: string;
  /**
   * Relationship id of a background image.
   *
   * `BrtBkHim` names the relationship rather than the picture, exactly as `BrtDrawing` does. The image
   * itself is an ordinary medium in `xl/media/`, so the only thing this record adds is the link.
   */
  readonly backgroundRelationshipId?: string;
  /** Relationship id of the VML holding the header/footer or watermark images. */
  readonly headerFooterDrawingRelationshipId?: string;
  /** Conditional-formatting blocks, each a range and the rules on it. */
  readonly conditionalFormattings?: readonly SheetConditionalFormatting[];
  /** Resolves a rule's style to its `dxfId`. Built across the whole workbook before any sheet is written. */
  readonly dxfIndex?: { readonly indexOf: (style: unknown) => number };
  /** Hands out the next workbook-unique `iPri`. */
  readonly nextCfPriority?: (stated: number | undefined) => number;
  /** Sparkline groups, each with the cells its sparklines occupy and the ranges they plot. */
  readonly sparklineGroups?: readonly SheetSparklineGroup[];
  /** The sheet's own name, which a sparkline's data formula has to be qualified with. */
  readonly sheetName?: string;
  /** The range an auto filter covers. */
  readonly autoFilter?: string;
  /**
   * The `<filterColumn>` XML the XLSX reader preserved for that range, parsed into nested records here.
   *
   * XML rather than a structured model because that is what the model holds and there is no public setter
   * for a criterion — see `filter-criteria.ts` for why introducing one would have cost the XLSX path its
   * byte-exact round trip.
   */
  readonly autoFilterCriteriaXml?: string;
  /** Error warnings a range suppresses. */
  readonly ignoredErrors?: readonly IgnoredError[];
  /**
   * One entry per sheet view, in the order they belong to the workbook's views.
   *
   * A list rather than a single object: `BrtBeginWsViews` is a collection, and a sheet may carry one view
   * per workbook view. Writing only the first was the reason a second view was reported as a loss.
   */
  readonly viewSettings?: readonly WorksheetViewLike[];
  /**
   * Configured sheet protection.
   *
   * A `BrtSheetProtection` is written for every sheet regardless, because Excel does — so an
   * *unprotected* sheet loses nothing by having one and a protected sheet needed the fields filled in.
   */
  readonly sheetProtectionSettings?: SheetProtectionLike;
  /** Data validations, grouped so one record covers every range sharing a rule. */
  readonly validations?: readonly SheetValidation[];
  /** Frozen or split panes, when the sheet's view has any. */
  readonly pane?: SheetPane;
  /** Manual horizontal page breaks, one-based as the model holds them. */
  readonly rowBreaks?: readonly SheetBreak[];
  readonly columnBreaks?: readonly SheetBreak[];
  /**
   * Whether the workbook counts days from 1904.
   *
   * Cell values carry their own copy on `SheetCell`, because they are built one at a time. This one is for the
   * parts of a sheet that hold a serial without being a cell — currently the `type: "date"` bounds of a data
   * validation, which were being written against a hard-coded 1900 epoch and so sat 1,462 days away from the
   * cells they constrained in any 1904 workbook.
   */
  readonly date1904?: boolean;
}

/**
 * Serialise one `xl/worksheets/sheetN.bin`.
 *
 * The record order is Excel's, established by comparing against nine of its own workbooks, and is
 * asserted by the validator rather than left to this function's reading order.
 */
export function writeWorksheetPart(options: WriteWorksheetPartOptions): WrittenWorksheet {
  const { rows, strings, formats, formulaContext = {} } = options;
  const unsupported: string[] = [];
  const records: Emitted[] = [...worksheetPrologueRecords(options)];
  // The rows, through the same encoder a streaming caller drives one row at a time. Extracted rather than
  // inlined so the two cannot diverge: a buffered write and a streamed write must produce the same records for
  // the same rows, and the only honest way to guarantee that is for there to be one place that produces them.
  for (const row of sortedRows(rows)) {
    records.push(...encodeRowRecords(row, { strings, formats, formulaContext, unsupported }));
  }
  records.push(...worksheetEpilogueRecords(options, unsupported));
  return { bytes: encodeBiffRecords(records), unsupported };
}

/**
 * Everything a sheet part declares **before** its first row, ending with `BrtBeginSheetData`.
 *
 * Split out for the one caller that cannot have the rows yet. A streaming writer must put these bytes down when
 * the sheet is created — a consumer sizes its columns and places its panes before it has any content — and the
 * only field here that wants to look at the rows is `BrtWsDim`, which is why `omitDimension` exists and why it
 * is the sole thing a streaming caller gives up.
 *
 * Sequence matters and is not arbitrary: properties, dimension, views, format info, columns. That is the order
 * every reference workbook uses, and a records stream out of order is a repair rather than a warning.
 */
export function worksheetPrologueRecords(options: WriteWorksheetPartOptions): readonly Emitted[] {
  const {
    rows,
    formats,
    columns = [],
    formatInfo,
    sheetProperties,
    pane,
    viewSettings = [],
    omitDimension = false,
    occupiedRegions = []
  } = options;
  const records: Emitted[] = [record("BrtBeginSheet")];
  // First in every reference workbook, before the dimension — and it carries the VBA code name,
  // which a preserved `vbaProject.bin` needs in order to resolve its own sheets. Emitted
  // unconditionally because Excel does: a sheet with no tab colour still has properties.
  records.push(record("BrtWsProp", encodeSheetProperties(sheetProperties)));
  if (!omitDimension) {
    records.push(record("BrtWsDim", encodeRange(usedRange(rows, occupiedRegions))));
  }

  // A worksheet must declare at least one view before it declares any content. This library wrote
  // none, which is one of the reasons Excel rejected its output — a sheet with no view has nowhere
  // to be displayed.
  records.push(
    record("BrtBeginWsViews"),
    // One `BrtBeginWsView` per view the sheet declares, each naming the workbook view it belongs to
    // through `iWbkView`. A single view is the common case and is index 0; a second was previously
    // reported as a loss because this wrote one record with a hard-coded index.
    //
    // The pane and the selection sit *inside* a view. The pane goes on the first only: the model holds
    // one pane per sheet rather than one per view, so repeating it in every view would invent a claim
    // the model does not make.
    ...(viewSettings.length === 0
      ? [worksheetView(undefined, 0)]
      : viewSettings.map(worksheetView)
    ).flatMap((bytes, index) => [
      record("BrtBeginWsView", bytes),
      // Before the selections, because a pane is what a selection is *in*: each `BrtSel` names one of the
      // panes this record creates. Same order as XLSX, where `<pane>` precedes `<selection>`.
      ...(pane === undefined || index > 0 ? [] : [record("BrtPane", encodePane(pane))]),
      // One selection per pane the split creates, and just the top-left one when there is no split. A single
      // selection is what made Excel repair every view that carried a pane.
      ...(pane === undefined || index > 0
        ? [record("BrtSel", selection())]
        : paneSelections(pane).map(({ pane: pnn, row, column }) =>
            record("BrtSel", selection(pnn, row, column))
          )),
      record("BrtEndWsView")
    ]),
    record("BrtEndWsViews")
  );

  // Always, as Excel does: a consumer needs the sheet's defaults before it can interpret a row that
  // omits its height, and `undefined` here means "the defaults" rather than "no answer".
  records.push(record("BrtWsFmtInfo", encodeSheetFormatInfo(formatInfo)));
  // Column widths come before the cell data: a consumer sizes its columns before it has rows
  // to put in them, and the validator's ordering rules place the collection here.
  if (columns.length > 0) {
    records.push(
      // No payload. Excel writes this collection header empty — unlike the styles collections,
      // which do carry a count — and a four-byte count where Excel has none is a record Excel
      // cannot parse.
      record("BrtBeginColInfos")
    );
    for (const column of columns) {
      records.push(
        record(
          "BrtColInfo",
          new BinaryWriter()
            .writeUint32(column.firstColumn)
            .writeUint32(column.lastColumn)
            .writeUint32(Math.round(column.widthCharacters * COLUMN_WIDTH_UNITS))
            // The column's own cell format, in the same position as a row's. Written as 0 before,
            // which is why `ColumnModel.style` had no path out.
            .writeUint32(internStyle(formats, column))
            // The flag word, MS-XLSB 2.4.45. Unlike `BrtRowHdr` this genuinely is one `u16`:
            //
            //   bit 0     fHidden
            //   bit 1     fUserSet    — the width was set deliberately, so Excel keeps it rather than
            //                           recomputing one; without it a written width is advisory
            //   bit 2     fBestFit
            //   bit 3     fPhonetic
            //   bits 4-7  reserved1
            //   bits 8-10 iOutLevel
            //   bit 11    unused
            //   bit 12    fCollapsed
            //
            // Only `fUserSet` was written, which is why hidden, grouped, collapsed and best-fit columns were
            // on the loss list — the field was described correctly and simply not filled in.
            .writeUint16(
              (column.hidden === true ? 1 << 0 : 0) |
                // **`fUserSet` is set for every column that has a record at all.**
                //
                // It used to be derived from `isCustomWidth`, so a column present only because it is *hidden* or
                // *grouped* had the bit clear — and Excel sets it on all ten `BrtColInfo` records across the oracle's
                // reference workbooks, including ones whose width is the default.
                //
                // Read as English that is the right answer: a column with a record in `<cols>` is one somebody set
                // something on. The width is not the only thing a user can set, and `isCustomWidth` answers a narrower
                // question than the flag asks.
                (1 << 1) |
                (column.bestFit === true ? 1 << 2 : 0) |
                ((Math.max(0, Math.min(7, Math.trunc(column.outlineLevel ?? 0))) & 0x07) << 8) |
                (column.collapsed === true ? 1 << 12 : 0)
            )
            .toUint8Array()
        )
      );
    }
    records.push(record("BrtEndColInfos"));
  }

  records.push(record("BrtBeginSheetData"));
  return records;
}

/**
 * Everything a sheet part declares **after** its last row, beginning with `BrtEndSheetData`.
 *
 * Nothing here reads the rows — verified rather than assumed, since that is the property that makes a forward
 * single pass possible at all. Losses are appended to the caller's list for the same reason `encodeRowRecords`
 * does it: a streaming writer accumulates them across a whole workbook.
 */
export function worksheetEpilogueRecords(
  options: WriteWorksheetPartOptions,
  unsupported: string[]
): readonly Emitted[] {
  const {
    formulaContext = {},
    merges = [],
    pageSetup,
    drawingRelationshipId,
    legacyDrawingRelationshipId,
    backgroundRelationshipId,
    headerFooterDrawingRelationshipId,
    tableRelationshipIds,
    headerFooter,
    hyperlinks = [],
    autoFilter,
    autoFilterCriteriaXml,
    conditionalFormattings = [],
    dxfIndex,
    nextCfPriority,
    sparklineGroups = [],
    sheetName = "Sheet1",
    ignoredErrors = [],
    sheetProtectionSettings,
    validations = [],
    rowBreaks = [],
    columnBreaks = [],
    // A `type: "date"` bound is a serial, so it needs the workbook's epoch exactly as a cell value does. Without
    // it a 1904 workbook wrote its bounds 1,462 days from its cells, so a rule reading "on or after 2020-01-15"
    // rejected that very date. The XLSX writer had the same defect.
    date1904 = false
  } = options;
  const records: Emitted[] = [];
  records.push(record("BrtEndSheetData"));

  // Page setup goes after the cell data, which is the order every reference workbook uses. The
  // margins are written whenever the sheet has any page setup at all, because a file that
  // declares a paper size and no margins would print with the consumer's defaults rather than
  // the author's.
  // Sheet protection and print options come between the cell data and the margins, which is the
  // order every reference workbook uses. Neither is interpreted here; both are emitted because
  // Excel emits them and a file missing a record every real file has is a file this library has no
  // evidence is acceptable.
  // `BrtSheetProtectionIso` first when there is a password, because the specification requires the Iso
  // record to be *immediately followed* by the legacy one. Pushing it after would separate the pair.
  const protectionIso = sheetProtectionIso(sheetProtectionSettings);
  if (protectionIso !== undefined) {
    records.push(record("BrtSheetProtectionIso", protectionIso));
  }
  records.push(record("BrtSheetProtection", sheetProtection(sheetProtectionSettings)));

  // **After the sheet protection**, not before it. This sat between `BrtEndSheetData` and the protection, on
  // the reasoning that a consumer reads the cells and then learns which are merged — true, and not the order
  // Excel writes: it puts `BrtSheetProtection` first and the merge collection after it. Record order in this
  // format has been load-bearing twice already in this module, so the two are aligned rather than argued about.
  if (merges.length > 0) {
    records.push(
      record("BrtBeginMergeCells", new BinaryWriter().writeUint32(merges.length).toUint8Array())
    );
    for (const merge of merges) {
      records.push(record("BrtMergeCell", encodeRange(merge)));
    }
    records.push(record("BrtEndMergeCells"));
  }
  // Between the protection and the print options, which is where `poi-hyperlink.xlsb` and
  // `poi-testVarious.xlsb` both put it:
  //
  //   … BrtEndSheetData → BrtSheetProtection → BrtHLink → BrtPrintOptions → BrtMargins → BrtEndSheet
  //
  // One record per cell. Excel writes one per *range*, and the model holds one destination per cell, so
  // recovering the author's ranges would mean inventing a grouping it does not record — a run of
  // identical single-cell links displays identically.
  // After the sheet protection and before the data validations, which is the order XLSX uses — and the
  // record is a scope, so it needs its `End` even with nothing inside.
  //
  // Nothing inside is exactly what this writes: the *criteria* live in a `BrtBeginFilterColumn`
  // collection, and the model carries only the range. So the dropdowns appear on the right cells and an
  // applied filter is reported as lost, rather than the range being dropped because the criteria cannot
  // come with it.
  if (autoFilter !== undefined) {
    const encoded = encodeAutoFilter(autoFilter);
    if (encoded !== undefined) {
      records.push(record("BrtBeginAFilter", encoded));
      // The criteria nest *inside* the range record, per the worked example in MS-XLSB 3.4. Pushing them
      // after `BrtEndAFilter` would put them at worksheet scope, where they belong to nothing.
      if (autoFilterCriteriaXml !== undefined) {
        for (const [name, payload] of filterCriteriaRecords(autoFilterCriteriaXml).records) {
          records.push(record(name, payload));
        }
      }
      records.push(record("BrtEndAFilter"));
    }
  }

  // Conditional formatting, **before** the data validations. The XLSX worksheet xform carries that
  // constraint as a comment on its own render call — it is a schema ordering, not a preference.
  if (dxfIndex !== undefined && nextCfPriority !== undefined) {
    const formatting = conditionalFormattingRecords(
      conditionalFormattings,
      dxfIndex,
      formulaContext,
      nextCfPriority
    );
    records.push(...formatting.records);
    unsupported.push(...formatting.lost);
  }

  // Before the hyperlinks, which is where XLSX puts `<dataValidations>` too — after the conditional
  // formatting this writer does not emit, and before `<hyperlinks>`.
  //
  // `BrtBeginDVals` carries the count, so a validation that cannot be encoded has to be dropped *before*
  // the count is written rather than skipped inside the loop, or the header promises more records than
  // follow and a reader walks off the end of the collection.
  const encodedValidations = validations
    .map(validation => encodeValidation(validation, formulaContext, "data validation", date1904))
    .filter((bytes): bytes is Uint8Array => bytes !== undefined);
  if (encodedValidations.length > 0) {
    // **Eighteen bytes, with the count last.** MS-XLSB 2.5.36 makes this a `DVals`: a flag word, the input
    // prompt's on-screen position, an unused word, and only then `idvMac`. This wrote the count alone, four
    // bytes, so Excel read `idvMac` from offset 14 — past the end of the record — and the whole collection was
    // whatever that happened to be.
    records.push(record("BrtBeginDVals", dataValidationHeader(encodedValidations.length)));
    for (const bytes of encodedValidations) {
      records.push(record("BrtDVal", bytes));
    }
    records.push(record("BrtEndDVals"));
  }

  for (const link of hyperlinks) {
    records.push(
      record(
        "BrtHLink",
        concatUint8Arrays([
          encodeRange({
            firstRow: link.row,
            lastRow: link.row,
            firstColumn: link.column,
            lastColumn: link.column
          }),
          encodeNullableWideString(link.relationshipId),
          // **Location is the destination for a link inside the workbook, and it used to be written empty.**
          //
          // The comment here said the destination is always the relationship. That is true of an external link and
          // false of an internal one: OOXML writes `<hyperlink ref="E4" location="Linked!A1"/>` with no `r:id`, and
          // Excel's BIFF12 save puts `Linked!A1` in this field and leaves the id empty. Writing a relationship instead
          // produced a link that navigated nowhere — the reason it went unnoticed is that both corpus files happen to
          // hold only external links, so "empty in both corpus files" was a true observation about a biased sample.
          //
          // Tooltip and display stay empty: the display text is the cell's own value, and the model carries no
          // tooltip for a hyperlink.
          encodeWideString(link.location ?? ""),
          encodeWideString(""),
          encodeWideString("")
        ])
      )
    );
  }
  // The four print options the record carries, from the same `pageSetup` the records around it come from. They
  // were dropped for years because this record's bits were left uninterpreted.
  records.push(record("BrtPrintOptions", printOptions(pageSetup as PrintOptionsLike)));
  records.push(record("BrtMargins", encodeMargins(pageSetup?.margins)));
  records.push(record("BrtPageSetup", encodePageSetup(pageSetup)));

  // After the margins, which is where `picture.xlsb` puts it. A sheet has at most one drawing —
  // every picture and shape on it is an anchor inside that one part — so this is a single id rather
  // than a collection.
  // Between the page setup and the drawing, which is the order `date.xlsb` uses. Written only when
  // the sheet says something: an empty header/footer pair is a scope with nothing in it.
  if (hasHeaderFooter(headerFooter)) {
    records.push(
      record("BrtBeginHeaderFooter", encodeHeaderFooter(headerFooter)),
      record("BrtEndHeaderFooter")
    );
  }

  // After the header and footer, before the drawing — the order this library's own XLSX writer uses,
  // which mirrors the schema sequence BIFF12's worksheet grammar follows.
  //
  // `BrtBeginRwBrk` carries the count *twice*: `ibrkMac` and `ibrkManMac`, which the specification's MUST
  // makes equal. Only manual breaks are written, which is what makes that true — an automatic break is
  // Excel's own pagination, recomputed on open, so writing one back would pin a decision nobody made.
  for (const [scope, breaks, axis] of [
    ["RwBrk", rowBreaks, "row"],
    ["ColBrk", columnBreaks, "column"]
  ] as const) {
    const manual = breaks.filter(entry => entry.man !== 0);
    if (manual.length === 0) {
      continue;
    }
    const count = new BinaryWriter().writeUint32(manual.length).writeUint32(manual.length);
    records.push(record(`BrtBegin${scope}`, count.toUint8Array()));
    for (const entry of manual) {
      records.push(record("BrtBrk", encodeBreak(entry, axis)));
    }
    records.push(record(`BrtEnd${scope}`));
  }

  // Before the drawing, as XLSX renders `<ignoredErrors>` before `<drawing>`. A counted collection, so
  // the entries that cannot be encoded are dropped before the count is written.
  const encodedIgnored = ignoredErrors
    .map(entry => encodeIgnoredError(entry))
    .filter((bytes): bytes is Uint8Array => bytes !== undefined);
  if (encodedIgnored.length > 0) {
    records.push(record("BrtBeginCellIgnoreECs"));
    for (const bytes of encodedIgnored) {
      records.push(record("BrtCellIgnoreEC", bytes));
    }
    records.push(record("BrtEndCellIgnoreECs"));
  }

  // Sparklines, before the drawing. They are future records inside `BrtBeginSparklineGroups`, which the
  // worksheet grammar places among the trailing collections — and the drawing records come last of all.

  records.push(...sparklineRecords(sparklineGroups, formulaContext, sheetName));

  if (drawingRelationshipId !== undefined) {
    records.push(record("BrtDrawing", encodeDrawing(drawingRelationshipId)));
  }

  // After `BrtDrawing`, which is the order `poi-testVarious.xlsb` uses — it carries both, at rIds 4 and
  // 5 respectively. The payload is the same `XLWideString` relationship id, so `encodeDrawing` serves
  // both records rather than a second function that would differ only in name.
  if (legacyDrawingRelationshipId !== undefined) {
    records.push(record("BrtLegacyDrawing", encodeDrawing(legacyDrawingRelationshipId)));
  }

  // `BrtLegacyDrawingHF` then `BrtBkHim`, both `XLWideString` relationship ids like the two above — which
  // is why `encodeDrawing` serves all four rather than four functions differing only in name.
  if (headerFooterDrawingRelationshipId !== undefined) {
    records.push(record("BrtLegacyDrawingHF", encodeDrawing(headerFooterDrawingRelationshipId)));
  }
  if (backgroundRelationshipId !== undefined) {
    records.push(record("BrtBkHim", encodeDrawing(backgroundRelationshipId)));
  }

  // **`BrtBeginListParts`, last before the end of the sheet — and this is observed, not inferred.** The oracle
  // case `15-table-with-drawing` puts a table, a picture and a comment on one sheet so that all four part
  // pointers appear in a single stream, and Excel's own output for it is
  // `BrtPageSetup → BrtDrawing → BrtLegacyDrawing → BrtBeginListParts → BrtListPart → BrtEndListParts →
  // BrtEndSheet`, which this matches exactly. It was placed here on inference first, from a file that carried
  // no drawing; the case exists because that inference needed checking rather than believing.
  if (tableRelationshipIds !== undefined && tableRelationshipIds.length > 0) {
    records.push(
      record(
        "BrtBeginListParts",
        new BinaryWriter().writeUint32(tableRelationshipIds.length).toUint8Array()
      )
    );
    for (const relationshipId of tableRelationshipIds) {
      // The payload is an `XLWideString` relationship id, the same shape as `BrtDrawing`'s — which is why
      // `encodeDrawing` serves this too rather than a second function differing only in name.
      records.push(record("BrtListPart", encodeDrawing(relationshipId)));
    }
    records.push(record("BrtEndListParts"));
  }
  records.push(record("BrtEndSheet"));
  return records;
}

/**
 * Rows in the order the format requires.
 *
 * Ascending by row, and cells within a row ascending by column — a streaming reader relies on both and the
 * validator enforces the first. Sorting here rather than trusting the caller means a model built in any order
 * still produces a valid part; a *streaming* caller has already committed its rows in order, so this is a no-op
 * for it rather than a second buffer.
 */
export function sortedRows(rows: readonly SheetRow[]): readonly SheetRow[] {
  return [...rows].sort((left, right) => left.row - right.row);
}

/**
 * One row as records: its header, then its cells.
 *
 * **The single place a row becomes records.** `writeWorksheetPart` calls it in a loop and a streaming writer
 * calls it as each row is committed, so a buffered package and a streamed one cannot disagree about a row — the
 * thing that would otherwise be impossible to verify, since the two would be different code producing bytes
 * nobody compares.
 *
 * `unsupported` is appended to rather than returned, because a caller collects it across every row and a
 * per-row array would make that the caller's bookkeeping.
 */
export function encodeRowRecords(
  row: SheetRow,
  context: {
    readonly strings: SharedStringTable;
    readonly formats: CellFormatTable;
    readonly formulaContext: PtgContext;
    readonly unsupported: string[];
  }
): readonly Emitted[] {
  const { strings, formats, formulaContext, unsupported } = context;
  const records: Emitted[] = [];

  // The inclusive column range the row's cells occupy, which the row header declares so a
  // consumer can size its buffers before reading them. A row with no cells declares no span.
  // One pass, no array. `Math.min(...columns)` allocated a copy of every row's columns and then
  // spread it into an argument list, which for a wide enough row is not merely wasteful — it is a
  // call that can exceed the engine's argument limit.
  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (const cell of row.cells) {
    if (cell.column < first) {
      first = cell.column;
    }
    if (cell.column > last) {
      last = cell.column;
    }
  }
  // **The row's own range, not the sheet's — and Excel writes the sheet's.**
  //
  // Excel puts `{0, 4}` on all four rows of the oracle's `14-hyperlinks`, including the first, which holds three
  // cells; that matches XLSX's `spans`, which is also sheet-wide. Making this sheet-wide was tried and reverted,
  // because a *streaming* writer has not seen the later rows when it emits a row header, so the change made a streamed
  // part differ from a buffered one — and `worksheet-stream.test.ts` exists to hold those byte-identical.
  //
  // That invariant is worth more than this field. A row span is a hint for sizing a buffer before reading the cells,
  // and a narrower one is correct for the row it describes; a streamed and a buffered write of the same rows
  // disagreeing is the class of defect this codec has had eight of.
  const span = last < 0 ? undefined : { first, last };
  records.push(record("BrtRowHdr", encodeRowHeader(row, internStyle(formats, row), span)));
  for (const cell of [...row.cells].sort((left, right) => left.column - right.column)) {
    const address = `${encodeCol(cell.column)}${cell.row + 1}`;
    if (cell.unsupported) {
      unsupported.push(`${address}: ${cell.unsupported}`);
    }
    // Interned once, because both branches below need it. Reading it back off `cell` in the
    // rejection branch is what made a cell whose formula could not be encoded lose its number
    // format and font as well: `SheetCell.styleIndex` is never populated by the model reader,
    // so that branch always fell back to 0 — the "no formatting" entry.
    // A date with no format of its own gets the built-in date format, as this library's XLSX writer does with
    // its `dateStyleId`. Without it the cell holds a serial number and says nothing about how to show it, so
    // a date written to XLSB opened as `45306` — the value was right and unreadable.
    const styleIndex = internStyle(
      formats,
      cell.value instanceof Date && cell.numberFormat === undefined
        ? { ...cell, numberFormat: DEFAULT_DATE_FORMAT }
        : cell
    );
    const emitted = encodeCellRecord({ ...cell, styleIndex }, strings, formulaContext, formats);
    if (emitted === undefined || isRefused(emitted)) {
      // The encoder refused. The reason — which the encoder hands back rather than swallowing — is reported, and the
      // cell keeps its position and its formatting.
      const reason = isRefused(emitted) ? emitted.reason : "formula";
      unsupported.push(`${address}: ${reason}`);
      // **The cached value survives the formula.**
      //
      // This wrote a `BrtCellBlank`, and the comment claimed "only the formula is lost". It was not: the value the
      // formula had evaluated to went with it, so a cell displaying `#NAME?` came back empty.
      //
      // **The reasoning it replaces was considered, and is worth answering rather than deleting.** A test named it:
      // "emitting the cached result as a plain number would produce a cell that looks right and never recalculates —
      // the failure mode that makes a converter untrustworthy". True, and it weighs a static value against a blank —
      // but the formula is gone in both cases, so the choice is between a cell holding the number it held and a cell
      // holding nothing. A blank makes the package *assert* the cell was empty, which is false; a literal asserts only
      // what it is. It also loses strictly more.
      //
      // What settles it is who arrives here. `unsupported` defaults to `"error"`, so this path is reached only by a
      // caller who passed `"ignore"` — who has said "write what you can". Discarding a value this writer *can* express
      // is not caution towards that caller, and the loss is reported to them either way.
      //
      // `formulaCachedResultLoss` already states the mirror rule — a cached result this writer cannot express is no
      // reason to drop the expression — and this is that rule the other way round.
      //
      // Retried as a *literal*: the same encoder with the formula fields removed, so the value goes through the
      // ordinary number/string/boolean/error paths rather than a second implementation of them. Found by
      // `verify:xlsb-corpus` on `poi-testVarious`'s `mySheet1!B14`, a `COS(NA)` whose `NA` is a name defined by an
      // expression — which the model cannot hold, so the formula genuinely cannot be re-encoded.
      const literal = encodeCellRecord(
        { ...cell, styleIndex, formula: undefined, sharedFormula: undefined, shareType: undefined },
        strings,
        formulaContext,
        formats
      );
      records.push(
        ...(literal === undefined || isRefused(literal)
          ? [record("BrtCellBlank", encodeCell({ column: cell.column, styleIndex }))]
          : literal)
      );
      continue;
    }
    // Spread rather than pushed: a shared or array formula's master cell is *two* records — the cell,
    // then the `BrtShrFmla`/`BrtArrFmla` that carries the expression the cell's `PtgExp` defers to.
    records.push(...emitted);
  }
  return records;
}
