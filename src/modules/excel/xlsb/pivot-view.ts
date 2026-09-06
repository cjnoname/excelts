/**
 * The PivotTable view part — `pivotTable{n}.bin`, the third of the four things a pivot table needs.
 *
 * The other three are in `pivot-cache.ts`. Neither module is wired into the package writer yet: the
 * specification requires one cache definition part *per* `BrtBeginPivotCacheID` record in the workbook, so a
 * package carrying some of these and not others points at things that are not there.
 *
 * **The record order comes from MS-XLSB section 3.8**, a fifty-seven step byte-level worked example of this
 * exact sequence. Two field layouts were ambiguous in their own 2.4.x tables and the example's *total record
 * size* disambiguated them — `BrtBeginSXDI` most of all, where three consecutive rows are all called `ifmt`
 * and only the declared `0x3B` reveals that the trailing `reserved` is inside the `PivotNumFmt` rather than
 * beside it.
 */

import type { PivotRecord } from "@excel/xlsb/pivot-cache";
import { encodeTableStyleClient } from "@excel/xlsb/table-style";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * `DataConsolidationFunction` — `iiftab` on a `BrtBeginSXDI`.
 *
 * Worth reading against the model's own `PivotTableSubtotal` union, because the two orders differ: the record
 * puts `count` (count of all values) at 1 and `countNums` at 6, while OOXML spells the first `count` and the
 * second `countNums` — so a mapping by position in the model's union would swap them, and a pivot table would
 * quietly report a different number.
 */
const CONSOLIDATION_FUNCTION: Readonly<Record<string, number>> = {
  sum: 0x00,
  count: 0x01,
  average: 0x02,
  max: 0x03,
  min: 0x04,
  product: 0x05,
  countNums: 0x06,
  stdDev: 0x07,
  // `stdDevP` and `varP` with a capital P, because that is how the model's own `PivotTableSubtotal` spells
  // them. They were lower-cased here first, which made a `stdDevP` metric fall through to SUM — a pivot
  // table reporting a total where a standard deviation was asked for, with nothing to indicate it. The keys
  // are checked against `VALID_SUBTOTALS` by the test so the two spellings cannot drift apart again.
  stdDevP: 0x08,
  var: 0x09,
  varP: 0x0a
};

/** `PivotItemType`. `PITDATA` is an ordinary item; `PITGRAND` is the grand-total line. */
export const PIT_DATA = 0x00;
/**
 * `BrtBeginSXVD`'s 32-bit flag field, by name.
 *
 * These are numbered because they were written as bare shifts and two of them were wrong: a comment saying
 * "plus `fOutline` and `fSubtotalAtTop`" sat above `(1 << 9) | (1 << 11)`, which are `fServerBased` and
 * `fPageBreaksBetweenItems`. The intent was right and the arithmetic was not, and nothing could see the
 * difference — least of all a round trip, since the reader read back whatever the writer put there.
 *
 * `fServerBased` is the one that mattered: it claims the field's items come from an ODBC or OLAP server,
 * which for a cache over a worksheet range is false. Excel's answer was
 * `Removed Feature: PivotTable report … (PivotTable view)`.
 */
const SXVD = {
  dragToRow: 0,
  dragToColumn: 1,
  dragToPage: 2,
  dragToHide: 3,
  dragToData: 4,
  showAllItems: 5,
  outline: 6,
  insertBlankRow: 7,
  subtotalAtTop: 8,
  serverBased: 9,
  pageBreaksBetweenItems: 11,
  autoSort: 12,
  ascendSort: 13,
  autoShow: 14,
  topAutoShow: 15,
  hideNewItems: 16,
  hasAdvFilter: 17,
  filterInclusive: 18
} as const;

/**
 * What Excel sets on a pivot field, read out of an XLSB Excel produced for this very pivot: `0x0004811F`.
 *
 * The five drag permissions, `fSubtotalAtTop`, and two "which way round" bits that are dead until the feature
 * they qualify is switched on. Section 3.8.29's example additionally has `fOutline` and `fAscendSort`; they are
 * absent here because Excel omits them for a field in tabular, non-compact form, which is what this writer
 * produces and what its XLSX counterpart declares with `outline="0"`.
 */
const SXVD_DEFAULT_FLAGS =
  (1 << SXVD.dragToRow) |
  (1 << SXVD.dragToColumn) |
  (1 << SXVD.dragToPage) |
  (1 << SXVD.dragToHide) |
  (1 << SXVD.dragToData) |
  (1 << SXVD.subtotalAtTop) |
  (1 << SXVD.topAutoShow) |
  (1 << SXVD.filterInclusive);

/** `PITDEFAULT` — a subtotal using whatever aggregation the data items specify. XLSX writes `<item t="default"/>`. */
export const PIT_DEFAULT = 0x01;
export const PIT_GRAND = 0x0d;

/** `DataFunctionalityLevel` 3, matching the cache this view reads. */
/**
 * The application version this writer claims, for `bVerSxMacro` and `bVerCache*`.
 *
 * Eight, not three. Three says Excel 2007 and is what the specification's examples carry, being of that
 * vintage; Excel writes 8 today and so does this library's XLSX writer (`createdVersion="8"`).
 */
const PIVOT_APP_VERSION = 8;

/** `bVerSxUpdateableMin` — the oldest version allowed to update the view. Three, as Excel writes. */
const PIVOT_MIN_VERSION = 3;

/** An `XLWideString`: a four-byte character count, then UTF-16. */
function wideString(value: string): Uint8Array {
  const characters = [...value];
  const writer = new BinaryWriter().writeUint32(characters.length);
  for (const character of characters.join("")) {
    writer.writeUint16(character.charCodeAt(0));
  }
  return writer.toUint8Array();
}

/** A counted array of 32-bit field indices, which four of these collections are. */
function indexArray(indices: readonly number[]): Uint8Array {
  const writer = new BinaryWriter().writeUint32(indices.length);
  for (const index of indices) {
    writer.writeUint32(index);
  }
  return writer.toUint8Array();
}

/** What the view part needs from the model. */
export interface PivotViewModel {
  /** The view's unique name within its sheet. */
  readonly name: string;
  /** `idSx` of the cache, which must equal a `BrtBeginPivotCacheID` in the workbook. */
  readonly cacheId: number;
  /** Where the view sits, zero-based and inclusive. */
  /**
   * How many columns the row area occupies — one per row field in the tabular layout this writer emits.
   *
   * Carried rather than recomputed so the body's right edge and `colFirstData` come from one number. They were
   * derived independently and disagreed: the extent counted a single row column and so did `colFirstData`, which
   * was wrong for every pivot with more than one row field.
   */
  readonly rowAreaWidth?: number;
  /**
   * How many column fields the view has — each one occupies a header row above the data.
   *
   * `rwFirstData` was fixed at one row below `rfxGeom.rwFirst`, which is right only when the column axis is
   * empty: a pivot with a column field puts that field's items on their own row and its data starts below them.
   */
  readonly columnFieldCount?: number;
  readonly location: {
    readonly rowFirst: number;
    readonly rowLast: number;
    readonly columnFirst: number;
    readonly columnLast: number;
  };
  /** One entry per cache field, in cache order — the view has a pivot field for every cache field. */
  readonly fields: readonly {
    readonly name: string;
    /** How many pivot items this field has, which is its cache field's item count. */
    readonly itemCount: number;
    /**
     * Cache-item indices in the order the field *displays* them.
     *
     * **The cache is identity and the view is presentation, and getting that backwards renumbered everything.** A cache
     * field's items are addressed by index, so their order is fixed by the data — Excel writes them in first-appearance
     * order. The pivot field then references them in display order, which for a text field is sorted: against Excel's
     * own `05-pivots`, the cache holds `APAC, EMEA, AMER` and the view's items are `2, 0, 1`.
     *
     * This library had it the other way round — a sorted cache and an index-ordered view — which agreed with itself and
     * differed from Excel in twenty-seven records across three record types.
     *
     * Absent means "index order", which is right for a field whose items are already in display order.
     */
    readonly itemOrder?: readonly number[];
    /**
     * Where the field sits, treating row, column and page as the mutually exclusive choice `sxaxis` makes
     * them. The data axis is **not** part of this choice — see `dataField`.
     */
    readonly axis: "row" | "column" | "page" | "data" | "none";
    /**
     * Whether the field is also summarised as a data item.
     *
     * `sxaxis` has four independent bits (MS-XLSB 2.5.146), and `sxaxisData` is one of them — a field can be
     * a row field *and* a data field, which is what `axis="axisRow" dataField="1"` expresses in XLSX. The
     * single `axis` string could not say both, so a field in `rows` and `values` at once was written with
     * `sxaxisRw` only and Excel repaired the view. A comment here claimed the row placement "wins" and the
     * field "still appears as a data item"; the second half was not implemented anywhere.
     */
    readonly dataField?: boolean;
  }[];
  /** Field indices on each axis, in display order. */
  readonly rowFields: readonly number[];
  /**
   * The pivot lines the row axis shows, when the adapter could work them out from the cache records.
   *
   * Only the combinations that actually occur, in item order, with a subtotal after each outer group — which is
   * what Excel writes and cannot be derived from the field list alone. Absent for a model built without cache
   * records, and `rowAxisLines` falls back to the cross product then.
   */
  readonly rowLines?: readonly PivotLine[];
  /**
   * The same for the column axis, when a field sits on it.
   *
   * A pivot with no column field still needs one entry-less line — the data field's own column — and that case
   * needs no records to work out, so it stays in the writer.
   */
  readonly columnLines?: readonly PivotLine[];
  readonly columnFields: readonly number[];
  readonly pageFields: readonly number[];
  /** Data items: which field, which aggregation, and the caption to show. */
  readonly dataItems: readonly {
    readonly field: number;
    readonly subtotal: string;
    readonly caption: string;
  }[];
  /** The caption above the data-field column when there are two or more data items. */
  readonly dataCaption: string;
}

/**
 * `pivotTable{n}.bin`.
 *
 * ```
 * BrtBeginSXView
 *   BrtBeginSXLocation … BrtEndSXLocation
 *   BrtBeginSXVDs
 *     BrtBeginSXVD  [ BrtBeginSXVIs BrtBeginSXVI… BrtEndSXVIs ]  BrtEndSXVD   … once per field
 *   BrtEndSXVDs
 *   BrtBeginISXVDRws … BrtEndISXVDRws
 *   BrtBeginSXLIRws  [ BrtBeginSXLI BrtBeginISXVIs BrtEndISXVIs BrtEndSXLI ]  BrtEndSXLIRws
 *   BrtBeginISXVDCols … BrtEndISXVDCols       ← grouped with its own lines, not with ISXVDRws
 *   BrtBeginSXLICols … BrtEndSXLICols
 *   BrtBeginSXPIs  [ BrtBeginSXPI BrtEndSXPI ]  BrtEndSXPIs
 *   BrtBeginSXDIs  [ BrtBeginSXDI BrtEndSXDI ]  BrtEndSXDIs
 * BrtEndSXView
 * ```
 *
 * **The pivot lines are enumerated.** The XLSX writer emits a single `<rowItems>` grand total and relies on
 * `refreshOnLoad` to expand it, and Excel accepts that in XLSX. It does not accept it here — it removed the
 * view until the lines were written out. Everything in this file's structure was checked against an XLSB that
 * Excel itself produced by saving this library's working XLSX in binary form; where the two disagreed, Excel's
 * shape won.
 *
 * Known limitation: with more than one row field the enumeration is the plain cross product of the fields'
 * items, without the nested subtotal lines Excel inserts. The single-row-field case matches Excel exactly.
 */
export function pivotViewRecords(view: PivotViewModel): PivotRecord[] {
  const records: PivotRecord[] = [
    ["BrtBeginSXView", viewPayload(view)],
    ["BrtBeginSXLocation", locationPayload(view)],
    ["BrtEndSXLocation", undefined],
    ["BrtBeginSXVDs", new BinaryWriter().writeUint32(view.fields.length).toUint8Array()]
  ];
  for (const field of view.fields) {
    records.push(["BrtBeginSXVD", fieldPayload(field)]);
    // **On an axis, not merely having items** — the same correction as the `defaultSubtotal` flag in `fieldPayload`,
    // and it has to be the same condition or the flag and the records disagree again. A field the view places nowhere
    // has no item list in Excel's output even when the *cache* holds shared items for it, which it now does for an
    // unused date column.
    const onAxis = field.axis === "row" || field.axis === "column" || field.axis === "page";
    if (onAxis && field.itemCount > 0) {
      // One `PITDATA` item per cache item, **then a `PITDEFAULT`** — the automatic subtotal a grand total is
      // drawn from. It was missing, and the count said so: this library's XLSX writer emits
      // `count="{items + 1}"` with a trailing `<item t="default"/>` and calls it "required default item for
      // subtotals/grand totals", while the layout below writes a `PITGRAND` line that had nothing to total.
      records.push([
        "BrtBeginSXVIs",
        new BinaryWriter().writeUint32(field.itemCount + 1).toUint8Array()
      ]);
      const order =
        field.itemOrder ?? Array.from({ length: field.itemCount }, (_unused, index) => index);
      for (const item of order) {
        records.push(["BrtBeginSXVI", itemPayload(PIT_DATA, item)]);
        records.push(["BrtEndSXVI", undefined]);
      }
      // `iCache` is -1 here: it MUST be for any type other than `PITDATA`, and a subtotal refers to no single
      // cache item.
      records.push(["BrtBeginSXVI", itemPayload(PIT_DEFAULT, -1)]);
      records.push(["BrtEndSXVI", undefined]);
      records.push(["BrtEndSXVIs", undefined]);
    }
    records.push(["BrtEndSXVD", undefined]);
  }
  records.push(["BrtEndSXVDs", undefined]);

  // The axis membership: a counted array of indices into the `BrtBeginSXVDs` collection above, which is why
  // the view has a pivot field for *every* cache field even when most sit on no axis — the indices are
  // positions in that collection, not a separate numbering.
  //
  // **An axis with no fields gets no record at all.** Excel omits `BrtBeginISXVDCols` and `BrtBeginSXPIs`
  // entirely for a pivot with no column and no page fields; this wrote both as empty collections. Verified
  // against a file Excel produced by saving this library's own working XLSX as XLSB.
  records.push(["BrtBeginISXVDRws", indexArray(view.rowFields)]);
  records.push(["BrtEndISXVDRws", undefined]);
  // **The column axis's field list comes after the row *lines*, not next to the row field list.**
  //
  // The sequence sketched at the top of this module put the two field lists together, and Excel groups each axis with
  // its own lines instead: `ISXVDRws`, `SXLIRws`, `ISXVDCols`, `SXLICols`. The records themselves are byte-identical
  // either way — this is where they sit — and grouping by axis is also the more defensible reading, since a lines
  // collection is meaningless without the field list it indexes.
  const columnAxis = columnAxisFields(view);

  // **The row lines are enumerated, one per displayed row, then a grand total.** They were written as a single
  // grand-total line on the reasoning that Excel recomputes the layout on refresh — which is what this
  // library's XLSX writer does, and Excel accepts it *in XLSX*. It does not accept it here: it answered
  // `Removed Feature: PivotTable report … (PivotTable view)` until the lines were expanded. Excel's own XLSB
  // for the same two-item pivot has three lines — `[0]`, `[1]` and a `PITGRAND` carrying `[0]` — each with
  // `cisxvis = 1`.
  const rowLines = rowAxisLines(view);
  records.push(["BrtBeginSXLIRws", new BinaryWriter().writeUint32(rowLines.length).toUint8Array()]);
  for (const line of rowLines) {
    records.push(["BrtBeginSXLI", linePayload(line.itemType, line.indices.length)]);
    records.push(["BrtBeginISXVIs", indexList(line.indices)]);
    records.push(["BrtEndISXVIs", undefined]);
    records.push(["BrtEndSXLI", undefined]);
  }
  records.push(["BrtEndSXLIRws", undefined]);

  // **An axis with no fields gets no record at all.** Excel omits `BrtBeginISXVDCols` and `BrtBeginSXPIs` entirely for
  // a pivot with no column and no page fields; this wrote both as empty collections.
  if (columnAxis.length > 0) {
    records.push(["BrtBeginISXVDCols", indexArray(columnAxis)]);
    records.push(["BrtEndISXVDCols", undefined]);
  }

  // The column axis, in two shapes.
  //
  // With a field on it the lines are enumerated exactly as the row ones are — Excel's file for a pivot with one
  // column field of three items has `[0]`, `[1]`, `[2]` and a grand total, where this wrote a single line.
  //
  // With no column field there is still one line, for the data field's own column, and it carries no entries —
  // and therefore **no `BrtBeginISXVIs` record**: Excel has `BrtBeginSXLI` followed straight by `BrtEndSXLI`
  // there, while every enumerated line has one.
  const columnLines = view.columnLines ?? [];
  if (columnLines.length === 0 && view.dataItems.length > 1) {
    // **The data field's own column axis.** With two or more data items and no column field, the data field
    // *is* the column axis — the `-2` in `BrtBeginISXVDCols` above says so — and it needs one line per data
    // item plus a grand total, exactly as this library's XLSX writer emits `colItems` with `values.length + 1`
    // entries. The single empty line the `else` branch below writes is right for one data item and is what
    // three of the example's pivots got instead; Excel answered `Removed Feature: PivotTable report`.
    //
    // The entries index the *data items*, not pivot items — an `ISXVI` on this axis is a position in
    // `BrtBeginSXDIs`, which is why the first line carries 0 and the XLSX form leaves its `<x/>` bare.
    records.push([
      "BrtBeginSXLICols",
      new BinaryWriter().writeUint32(view.dataItems.length + 1).toUint8Array()
    ]);
    view.dataItems.forEach((_item, position) => {
      records.push(["BrtBeginSXLI", linePayload(PIT_DATA, 1)]);
      records.push(["BrtBeginISXVIs", indexList([position])]);
      records.push(["BrtEndISXVIs", undefined]);
      records.push(["BrtEndSXLI", undefined]);
    });
    records.push(["BrtBeginSXLI", linePayload(PIT_GRAND, 1)]);
    records.push(["BrtBeginISXVIs", indexList([0])]);
    records.push(["BrtEndISXVIs", undefined]);
    records.push(["BrtEndSXLI", undefined]);
    records.push(["BrtEndSXLICols", undefined]);
  } else if (columnLines.length > 0) {
    records.push([
      "BrtBeginSXLICols",
      new BinaryWriter().writeUint32(columnLines.length).toUint8Array()
    ]);
    for (const line of columnLines) {
      records.push(["BrtBeginSXLI", linePayload(line.itemType, line.indices.length)]);
      records.push(["BrtBeginISXVIs", indexList(line.indices)]);
      records.push(["BrtEndISXVIs", undefined]);
      records.push(["BrtEndSXLI", undefined]);
    }
    records.push(["BrtEndSXLICols", undefined]);
  } else {
    records.push(["BrtBeginSXLICols", new BinaryWriter().writeUint32(1).toUint8Array()]);
    records.push(["BrtBeginSXLI", linePayload(PIT_DATA, 0)]);
    records.push(["BrtEndSXLI", undefined]);
    records.push(["BrtEndSXLICols", undefined]);
  }

  if (view.pageFields.length > 0) {
    records.push([
      "BrtBeginSXPIs",
      new BinaryWriter().writeUint32(view.pageFields.length).toUint8Array()
    ]);
    for (const field of view.pageFields) {
      records.push(["BrtBeginSXPI", pageItemPayload(field)]);
      records.push(["BrtEndSXPI", undefined]);
    }
    records.push(["BrtEndSXPIs", undefined]);
  }

  records.push([
    "BrtBeginSXDIs",
    new BinaryWriter().writeUint32(view.dataItems.length).toUint8Array()
  ]);
  for (const item of view.dataItems) {
    records.push(["BrtBeginSXDI", dataItemPayload(item)]);
    records.push(["BrtEndSXDI", undefined]);
  }
  records.push(["BrtEndSXDIs", undefined]);
  // Last inside the view, as Excel writes it.
  records.push(["BrtTableStyleClient", tableStylePayload()]);
  records.push(["BrtEndSXView", undefined]);
  return records;
}

/**
 * `BrtBeginSXView` — MS-XLSB 2.4.278. Thirty-two fixed bytes and up to eleven conditional strings.
 *
 * Three of the flags are **presence** flags for those strings, and two of them are **inverted**:
 * `fDisplayData` (bit 25 of the second word) says `irstData` *is* present and MUST be 1, while
 * `fEmptyDisplayErrorString` and `fEmptyDisplayNullString` say their strings are *absent*. So a minimal
 * record has to *set* the two "empty" bits and clear the rest — reading them as ordinary "has a value" flags
 * produces a record whose string fields are read from whatever follows it.
 */
function viewPayload(view: PivotViewModel): Uint8Array {
  // Every value below was read out of an XLSB that Excel wrote for this pivot table. Where a bit's purpose is
  // known it is named; where it is not, it is still written, because a view Excel will not open is worth less
  // than a view carrying a flag nobody here can explain.
  const writer = new BinaryWriter()
    .writeUint8(PIVOT_APP_VERSION)
    // `fDisplayImmediateItems`, `fNotViewCalculatedMembers`, `fPageMultipleItemLabel`.
    .writeUint8(0x41)
    // `fMemPropsInTips`.
    .writeUint8(0x40)
    // `cIndentInc` and `fNoHeaders`. Zero: Excel writes no indent increment for a non-compact layout, and 1
    // here was a guess at "Excel's default".
    .writeUint8(0)
    // Second flag word, `0x200A65F0`.
    .writeUint32(
      (1 << 4) | // fEnableWizard
        (1 << 5) | // fEnableDrilldown
        (1 << 6) | // fEnableFieldDialog
        (1 << 7) | // fPreserveFormatting
        (1 << 8) | // fAutoFormat
        (1 << 10) | // fDisplayNullString
        (1 << 13) | // fRwGrand
        (1 << 14) | // fColGrand
        (1 << 17) | // fRepeatItemsOnEachPrintedPage
        (1 << 19) | // fDisplayData — MUST be 1, `irstData` follows
        (1 << 29) // ibitAtrProt
    )
    // Third flag word, `0x000002D0`. `fCompactData` is **clear**: it was set here to "match what Excel writes
    // for a new pivot table", and Excel writes it clear for this one — as does this library's XLSX writer,
    // which declares `compactData="0"` in the file Excel opens.
    .writeUint32(
      (1 << (36 - 32)) | // fNewDropZones
        (1 << (38 - 32)) | // fEmptyDisplayErrorString
        (1 << (39 - 32)) | // fEmptyDisplayNullString
        (1 << (41 - 32)) // fSingleFilterPerField
    )
    // `sxaxis4Data`: the axis the data field sits on — see {@link dataFieldAxis} for why this is a constant.
    .writeUint8(dataFieldAxis())
    // `cWrapPage`: 0 means page fields do not wrap.
    .writeUint8(0)
    // `bVerSxLastUpdated`, then `bVerSxUpdateableMin` — the version that last touched the view, and the oldest
    // that may. Only the second is 3.
    .writeUint8(PIVOT_APP_VERSION)
    .writeUint8(PIVOT_MIN_VERSION)
    // `ipos4Data`: -1 puts the data field last on its axis.
    .writeUint32(0xffffffff)
    // `itblAutoFmt` and `reserved6`. An AutoFormat identifier of 1 goes with `fAutoFormat` above.
    .writeUint16(1)
    .writeUint16(0)
    // `dwCrtFmtId`: the next pivot-chart identifier. 0 because no pivot chart is written.
    .writeUint32(0)
    .writeUint32(view.cacheId);
  return concatUint8Arrays([
    writer.toUint8Array(),
    wideString(view.name),
    // `irstData`, present because `fDisplayData` is 1.
    wideString(view.dataCaption)
  ]);
}

/**
 * `BrtBeginSXLocation` — MS-XLSB 2.4.259. The body's extent, then four positions inside it.
 *
 * `rwFirstHead` must be less than or equal to `rwFirstData`, and when the view has no row or column area it
 * must equal `rfxGeom.rwFirst + 1`.
 *
 * **They are equal.** This put the data one row below the header, with a comment asserting that is where
 * Excel puts them — and section 3.8.27's worked example says otherwise in the plainest way available:
 * `rwFirstHead` and `rwFirstData` are both `0x00000005`. This library's XLSX writer agrees, emitting
 * `firstHeaderRow="1" firstDataRow="1"`, which are the same offset from the same origin. The first body row
 * carries a row label *and* its value, so there is nothing between them to skip.
 */
function locationPayload(view: PivotViewModel): Uint8Array {
  const { location } = view;
  const headerRow = location.rowFirst + 1;
  return (
    new BinaryWriter()
      .writeUint32(location.rowFirst)
      .writeUint32(location.rowLast)
      .writeUint32(location.columnFirst)
      .writeUint32(location.columnLast)
      .writeUint32(headerRow)
      // `rwFirstData`: below the header, and below one row per column field. Equal to `rwFirstHead` when the
      // column axis is empty, which is the case section 3.8.27's worked example covers.
      .writeUint32(headerRow + (view.columnFieldCount ?? 0))
      .writeUint32(location.columnFirst + (view.rowAreaWidth ?? 1))
      // `crwPage` and `ccolPage`: rows and columns occupied by page fields above the body.
      .writeUint32(view.pageFields.length)
      .writeUint32(view.pageFields.length > 0 ? 1 : 0)
      .toUint8Array()
  );
}

/** The `ISXVD` sentinel for the data field — MS-XLSB 2.5.84. Not a pivot field index. */
const ISXVD_DATA_FIELD = -2;

/**
 * The column axis as `BrtBeginISXVDCols` states it: the real column fields, then the data field if it is
 * there.
 *
 * `BrtBeginISXVDCols` is documented as specifying "the pivot fields that appear on the column axis **and
 * whether the data field appears on the column axis**" — the second half was missing. With two or more data
 * items the data field occupies a position on an axis, and this writer already declared that axis by writing
 * `sxaxis4Data = 0x02` unconditionally, without ever putting the `-2` there that makes the claim true. For a
 * pivot with no column fields the record was omitted altogether, so the view announced a data field on an
 * axis that did not exist; Excel answered `Removed Feature: PivotTable report`.
 *
 * The rule is the one this library's XLSX writer already applies to `colFields` — append the sentinel when
 * `values.length > 1`, whether or not there are real column fields — and it is deliberately expressed the
 * same way here so the two containers cannot drift.
 *
 * 2.5.84 requires `sxaxis4Data` to be `0x02` whenever this array contains `-2`, which {@link dataFieldAxis}
 * satisfies unconditionally. Note that the requirement does **not** run the other way — see that function.
 */
function columnAxisFields(view: PivotViewModel): readonly number[] {
  return view.dataItems.length > 1 ? [...view.columnFields, ISXVD_DATA_FIELD] : view.columnFields;
}

/**
 * `sxaxis4Data` — the axis the data field sits on. **Always the column axis, `0x02`.**
 *
 * This was briefly made conditional on the `-2` sentinel being present, by reading 2.5.84's
 *
 * > If an item in this array has a value equal to -2, the value in the `sxaxis4Data` field ... MUST be equal
 * > to `0x02`.
 *
 * as an equivalence. **It is an implication in one direction only**, and Excel settles the other: in the
 * oracle's `05-pivots` its `BrtBeginSXView` carries `sxaxis4Data = 0x02` for a pivot with a *single* data item
 * and **no `BrtBeginISXVDCols` record at all** — so `0x02` without a `-2` is not merely permitted, it is what
 * Excel writes. Making it conditional therefore fixed nothing and broke a case that had been byte-identical.
 *
 * The lesson is worth keeping next to the code: a `MUST` of the form "if A then B" constrains files with A. It
 * says nothing about files with B, and inferring `if B then A` from it is inventing a rule. When the converse
 * matters, Excel's bytes decide — which is what the oracle is for.
 */
function dataFieldAxis(): number {
  return 0x02;
}

/**
 * `BrtBeginSXVD` — MS-XLSB 2.4.273. Twenty fixed bytes, then up to three conditional strings.
 *
 * `sxaxis` is a bitfield rather than an enumeration, and the specification forbids combinations: row,
 * column and page are mutually exclusive. The data axis is a *separate* bit that may coexist with them,
 * which is how a field can be both a row field and a data field.
 */
function fieldPayload(field: PivotViewModel["fields"][number]): Uint8Array {
  const placement =
    field.axis === "row"
      ? 0x01
      : field.axis === "column"
        ? 0x02
        : field.axis === "page"
          ? 0x04
          : field.axis === "data"
            ? 0x08
            : 0x00;
  // `sxaxisData` is OR-ed in rather than selected between: the four bits are independent, and a field that is
  // both a row field and a data item needs `0x09`.
  const axis = placement | (field.dataField === true ? 0x08 : 0x00);
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint8(axis)
      // `fDefault` at bit 0 of the subtotal flags: this field shows the automatic subtotal a grand total is
      // drawn from.
      //
      // **Tied to `itemCount`, because that is the same condition that writes the `PITDEFAULT` item.** It was
      // `axis === "row" || axis === "column"`, and a page field has items too — so a page field declared *no*
      // default subtotal while its item list still ended with the default item that only a declared subtotal
      // may have. Excel answered `Repaired Records: PivotTable report` for every pivot with a page filter, and
      // the contradiction is invisible from either side alone: the flag is right for a row field and the item
      // list is right for all of them.
      //
      // This library's XLSX writer says the same thing in the other container's vocabulary: it emits
      // `defaultSubtotal="0"` only for value fields and fields on no axis — precisely those that get no
      // `<items>` — and leaves the attribute at its default of *true* for every field that does. Deriving both
      // from `itemCount` here is what makes the flag and the records unable to disagree again.
      // **Driven by the axis, not by the item count.** The two agreed for as long as only axis fields had shared
      // items, and the comment above records the rule correctly: a value field or a field on no axis gets no
      // `<items>` and no `defaultSubtotal`. Once the cache began materialising shared items for an unused *date*
      // column — which Excel does, see `makeCacheFields` — `itemCount > 0` started claiming a subtotal for a field
      // Excel leaves entirely at zero, and `BrtBeginSXVD` regressed while the cache was being fixed.
      .writeUint16(
        field.axis === "row" || field.axis === "column" || field.axis === "page" ? 0x0001 : 0x0000
      )
      // Second flag byte: `fDrilledLevel` … `fTensorSort`. **All clear**, which means no `irstName` follows.
      // `fDisplayName` was set at bit 5 and the field's name written after the fixed part — a 36-byte record
      // where Excel writes 20. The name is not the view's to state: it belongs to the cache field, and the
      // `irstName` here is for a *user-supplied caption* that overrides it.
      .writeUint8(0)
      // `ifmt`.
      .writeUint32(0)
      .writeUint32(SXVD_DEFAULT_FLAGS)
      // `citmAutoShow` — how many items an AutoShow filter would keep. Ten is what Excel writes; it is dead
      // while `fAutoShow` is 0, but zero is not what a switched-off filter looks like in Excel's own file.
      .writeUint32(10)
      // `isxdiAutoShow`: -1, no data item drives the AutoShow.
      .writeUint32(0xffffffff)
      .toUint8Array()
  ]);
}

/**
 * `BrtBeginSXVI` — MS-XLSB 2.4.277. Seven bytes: the item type, flags, and the cache item it refers to.
 *
 * `iCache` is **signed** and MUST be -1 for any type other than `PITDATA`. A `PITDATA` item refers to the
 * cache item at the same ordinal, which is the identity mapping a freshly built pivot table has before anyone
 * reorders or hides anything; the trailing `PITDEFAULT` subtotal refers to none and passes -1.
 */
function itemPayload(itemType: number, cacheItem: number): Uint8Array {
  return new BinaryWriter()
    .writeUint8(itemType)
    .writeUint16(0)
    .writeInt32(cacheItem)
    .toUint8Array();
}

/**
 * `BrtBeginSXLI` — MS-XLSB 2.4.252. Twelve bytes: `cSic`, `itmtype`, a reserved byte, `cisxvis` and `iData`.
 *
 * `cSic` is 0 because no entries are reused from a previous line. `iData` is 0 rather than -1: -1 is forbidden
 * only when a data field is on this axis, and 0 is the "ignored" value the specification names.
 *
 * **`cisxvis` counts the entries in the `BrtBeginISXVIs` that follows**, which carries no count of its own —
 * so the two are written together or not at all. A grand-total line on the row axis has one entry; the bare
 * line on the column axis has none, mirroring `<i t="grand"><x/></i>` against `<i/>` in the XLSX form.
 *
 * @param itemType - `PivotItemType`: `PITGRAND` for a grand total, `PITDATA` for a plain line.
 * @param entryCount - How many indices the following `BrtBeginISXVIs` holds.
 */
function linePayload(itemType: number, entryCount: number): Uint8Array {
  return new BinaryWriter()
    .writeUint16(0)
    .writeUint8(itemType)
    .writeUint8(0)
    .writeUint32(entryCount)
    .writeUint32(0)
    .toUint8Array();
}

/** One pivot line: its type and the item indices it names, one per field on the axis. */
export interface PivotLine {
  readonly itemType: number;
  readonly indices: readonly number[];
}

/**
 * The lines the row axis displays: every combination of the row fields' items, then the grand total.
 *
 * Excel's own file for a single row field with two items holds exactly `[0]`, `[1]`, then a `PITGRAND` line
 * carrying `[0]` — the grand total names an index too, rather than being an entry-less marker.
 *
 * With several row fields this returns the cross product, which is the right set of lines for a tabular layout
 * but omits the per-field subtotal lines Excel adds when `fDefault` is set. That is a real gap and is recorded
 * on `pivotViewRecords` rather than hidden here.
 */
function rowAxisLines(view: PivotViewModel): PivotLine[] {
  // Worked out from the cache records where they were available: only the combinations the data contains, with
  // a subtotal per outer group. The cross product below is the fallback, and for two row fields over three rows
  // it produced nine data lines where three exist — six of them naming pairs that never occur.
  if (view.rowLines !== undefined && view.rowLines.length > 0) {
    return [...view.rowLines];
  }
  const counts = view.rowFields.map(index => view.fields[index]?.itemCount ?? 0);
  if (counts.length === 0 || counts.some(count => count === 0)) {
    // Nothing to enumerate, so the grand total is the only line there can be.
    return [{ itemType: PIT_GRAND, indices: [0] }];
  }
  const lines: PivotLine[] = [];
  const indices = new Array<number>(counts.length).fill(0);
  for (;;) {
    lines.push({ itemType: PIT_DATA, indices: [...indices] });
    let axis = counts.length - 1;
    while (axis >= 0) {
      indices[axis] += 1;
      if (indices[axis]! < counts[axis]!) {
        break;
      }
      indices[axis] = 0;
      axis -= 1;
    }
    if (axis < 0) {
      break;
    }
  }
  lines.push({ itemType: PIT_GRAND, indices: [0] });
  return lines;
}

/** `BrtBeginISXVIs` — the indices themselves, with no count: `BrtBeginSXLI.cisxvis` holds that. */
function indexList(indices: readonly number[]): Uint8Array {
  const writer = new BinaryWriter();
  for (const index of indices) {
    writer.writeInt32(index);
  }
  return writer.toUint8Array();
}

/**
 * `BrtTableStyleClient` — which table style paints the PivotTable.
 *
 * The encoder is shared with the table part, which carries the same record; see `@excel/xlsb/table-style`
 * for how the six flags are pinned. Excel writes it inside `BrtBeginSXView` and this did not write it at all.
 *
 * The three flags below are Excel's, from a file it produced for this same pivot — its `0x32` is exactly the
 * three attributes `<pivotTableStyleInfo showRowHeaders="1" showColHeaders="1" showLastColumn="1"/>` sets.
 * They are stated as names rather than as that number so the word is assembled in one place: the literal was
 * unreadable next to a table's `0x0000` for the same record, and neither call site could see it shared a
 * word with the other.
 *
 * **Still a fixed default rather than the pivot's own setting.** The model carries no pivot style, so there
 * is nothing to derive from; when it gains one, this is the single call to change.
 */
function tableStylePayload(): Uint8Array {
  return encodeTableStyleClient(DEFAULT_PIVOT_STYLE, {
    lastColumn: true,
    rowHeaders: true,
    columnHeaders: true
  });
}

const DEFAULT_PIVOT_STYLE = "PivotStyleLight16";

/**
 * `BrtBeginSXPI` — one page-axis field and which of its items is selected. **Thirteen bytes.**
 *
 * This wrote twelve, and the missing one was the trailing flag byte (`fUnique`, `fDisplay`, six reserved
 * bits). A record one byte short does not merely lose a field: it desynchronises the reader for the whole
 * rest of the part, so Excel's answer was not "a page filter looks wrong" but
 * `Removed Part: /xl/pivotTables/pivotTableN.bin`. Nine of the twenty-five pivots in the example failed
 * that way, and they were exactly the nine with a page filter — no false positives, no false negatives.
 * Section 2.4.256's declared size is `0x0D`, which is 4 + 4 + 4 + 1 and closes only with the flag byte.
 *
 * `isxvi` was `0xFFFFFFFF` on the reasoning that -1 means "(All)". That is not one of the values the field
 * may take: 2.4.256 admits `0x00000000`–`0x00100000` for an item index, or `0x001000FE` to defer to the
 * page-filtering rules of 2.2.5.3.7.1.1 — which *is* the "no single item picked" case, and is what section
 * 3.8.55's worked example writes. `0xFFFFFFFF` is outside both.
 *
 * `isxth` is `0xFFFFFFFF`, not 0. The field is ignored for a non-OLAP PivotTable, so 0 was defensible on
 * paper; the worked example writes -1, and a reader is entitled to range-check an index it does not use —
 * the same argument that settled `isxvd`/`isxvi` in {@link dataItemPayload}.
 *
 * The flag bits stay clear: both name a string that follows the fixed part and applies only to OLAP
 * PivotTables, so setting either would promise a caption this writer does not emit.
 */
function pageItemPayload(field: number): Uint8Array {
  return new BinaryWriter()
    .writeUint32(field)
    .writeUint32(0x001000fe)
    .writeUint32(0xffffffff)
    .writeUint8(0)
    .toUint8Array();
}

/**
 * `BrtBeginSXDI` — MS-XLSB 2.4.244. Twenty-five fixed bytes, then the caption.
 *
 * The field table lists three consecutive rows all named `ifmt` plus a `reserved`, which does not add up; the
 * worked example's declared total of `0x3B` for a 34-byte caption is what resolves it — the `reserved` word
 * is *inside* the four-byte `PivotNumFmt`, not beside it. Reading it as a separate field makes this record
 * two bytes too long and every record after it in the part unreadable.
 */
function dataItemPayload(item: PivotViewModel["dataItems"][number]): Uint8Array {
  const consolidation = CONSOLIDATION_FUNCTION[item.subtotal] ?? CONSOLIDATION_FUNCTION.sum!;
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(item.field)
      .writeUint32(consolidation)
      // `df` — ShowDataAs. 0 is a normal value rather than a percentage or a difference.
      .writeUint32(0)
      // `isxvd` and `isxvi`, the base field and item a "difference from" format would use. Ignored for a
      // normal `df`, but their eight bytes are not optional — and **`isxvd` is an `ISXVD`, an index into the
      // `BrtBeginSXVDs` collection**, so -1 is not a value it can take. It was -1 here on the grounds that the
      // field is ignored, which is a different claim: a reader is entitled to range-check an index it does not
      // otherwise use. Both available references say 0 — section 3.8.57's example writes `0x00000000`, and this
      // library's XLSX writer emits `baseField="0" baseItem="0"` in a file Excel opens without complaint.
      .writeUint32(0)
      .writeUint32(0)
      // `PivotNumFmt`: the number format identifier and the reserved word that shares its four bytes.
      //
      // Section 3.8.57's field rows can be read as putting a *second*, separate `reserved` word here, and two
      // bytes were once added on that reading. The record's own declared size settles it against them: `0x3B`
      // is 59, the caption is `0x22` = 34, so the fixed part is 25 — which only works with one reserved word.
      // `BrtBeginPCDField` says the same thing independently (`0x30` total, `0x1C` name, 20 fixed). **When a
      // field table and a declared record size disagree, the size wins**; the table's indentation of a
      // structure's components is not reliable in this document.
      .writeUint32(0)
      // `fLoadDisplayName` — the caption follows.
      .writeUint8(1)
      .toUint8Array(),
    wideString(item.caption)
  ]);
}
