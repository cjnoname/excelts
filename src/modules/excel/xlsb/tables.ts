/**
 * Tables: the `xl/tables/table{N}.bin` part.
 *
 * A table is its own part, reached by a relationship from the sheet — not records inside the worksheet.
 * The part is one `BrtBeginList` describing the table, then a `BrtBeginListCols` collection holding one
 * `BrtBeginListCol` per column:
 *
 * ```text
 * BrtBeginList          56 fixed bytes, then six XLNullableWideStrings
 *   BrtBeginListCols    count
 *     BrtBeginListCol   24 fixed bytes, then six XLNullableWideStrings
 *     BrtEndListCol
 *   BrtEndListCols
 * BrtEndList
 * ```
 *
 * No corpus workbook contains one, so this is the specification's layout rather than Excel's bytes — but
 * MS-XLSB carries a **worked example** for both records (sections 3.3.4 and 3.3.6), which is stronger
 * evidence than a field list alone: the example's `BrtBeginListCol` is 0x38 bytes and the arithmetic
 * closes exactly at `24 + 4 + 12 + 4 + 4 + 4 + 4`, which pins both the field order and the four-byte
 * width of a null `XLNullableWideString`. The tests assert against that example.
 *
 * Three traps, all silent:
 *
 * - **`ilta`'s order is not the model's.** The record counts `none, average, count, countNums, max, min,
 *   sum, stdDev, var, custom`; the model's union reads `none, average, countNums, count, max, min,
 *   stdDev, var, sum, custom`. Two pairs are transposed and `sum` moves by three places, so mapping by
 *   index turns a column's average into a count. The mapping here is by name for that reason.
 * - **`stName` is NULL for a standard table, and the header text lives in `stCaption`.** The example
 *   says so explicitly — `stName` is null "because the `lt` field ... is equal to LTRANGE" — so writing
 *   the column name into `stName` and leaving `stCaption` empty produces a table whose headers are blank.
 * - **A `DXFId` of "none" is `0xFFFFFFFF`, not 0.** Zero is a valid index into the differential-format
 *   table, so a writer that leaves these fields zeroed claims every table is formatted by whatever
 *   happens to be first in it.
 */
import type { TableColumnProperties, TableStyleProperties } from "@excel/types";
import { encodeRange as encodeReference } from "@excel/utils/address";
import {
  encodeBiffRecords,
  encodeNullableWideString,
  encodeRange,
  readNullableWideString,
  readRange,
  readWideString,
  tryDecodeRange,
  type BiffRange
} from "@excel/xlsb/binary";
import { encodeTableStyleClient } from "@excel/xlsb/table-style";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** `ListType`, MS-XLSB 2.5.89. Only a standard table is written. */
const LTRANGE = 0x00000000;

/** `DXFId` meaning "no differential formatting". Not zero — zero is a real index. */
const NO_DXF = 0xffffffff;

/**
 * `ListTotalRowFunction`, MS-XLSB 2.5.88, in the record's own order.
 *
 * Keyed by the model's name rather than positional, because the two orders differ — see the header.
 */
const TOTALS_FUNCTION: readonly (TableColumnProperties["totalsRowFunction"] & string)[] = [
  "none",
  "average",
  "count",
  "countNums",
  "max",
  "min",
  "sum",
  "stdDev",
  "var",
  "custom"
];

/** A table, in the shape the model holds it. */
export interface SheetTable {
  /** The whole table including its header and totals rows, as `A1:C9`. */
  readonly ref: string;
  /** The programmatic name. Also the display name unless one is given separately. */
  readonly name: string;
  readonly displayName?: string;
  readonly headerRow?: boolean;
  readonly totalsRow?: boolean;
  readonly columns: readonly TableColumnProperties[];
  /**
   * Which table style paints it, and which of the style's parts are emphasised.
   *
   * Absent means the built-in default, which is what `Table.add` puts in the model.
   */
  readonly style?: TableStyleProperties;
  /**
   * The range the filter buttons cover, as `A1:B4`.
   *
   * **Not the table's own range**: it excludes the totals row, because a totals row is not filtered. Absent
   * means derive it, which is what a model that never had one round-tripped through XML needs.
   */
  readonly autoFilterRef?: string;
  /**
   * The table's workbook-unique numeric id.
   *
   * Assigned by the package writer rather than carried in the model, because `idList` must be unique
   * across the *workbook* and no single sheet can know that.
   */
  readonly id: number;
}

/** Serialise a whole `xl/tables/table{N}.bin`. */
export function encodeTablePart(table: SheetTable): Uint8Array | undefined {
  const range = tryDecodeRange(table.ref);
  if (range === undefined || table.columns.length === 0) {
    // A table with no range or no columns is not a table. Returning rather than throwing lets the
    // caller report it and still write the sheet.
    return undefined;
  }
  const records: Emitted[] = [record("BrtBeginList", encodeListHeader(table, range))];
  // **The filter buttons.** A table with a header row has them, and this part carried no `BrtBeginAFilter`
  // at all while the XLSX writer emitted `<autoFilter>` for the same table — so the same workbook saved two
  // ways differed in whether its table could be filtered. Excel puts the record here, before the columns.
  const filter = autoFilterRange(table, range);
  if (filter !== undefined) {
    records.push(record("BrtBeginAFilter", encodeRange(filter)), record("BrtEndAFilter"));
  }
  records.push(
    record("BrtBeginListCols", new BinaryWriter().writeUint32(table.columns.length).toUint8Array())
  );
  table.columns.forEach((column, index) => {
    records.push(
      record("BrtBeginListCol", encodeListColumn(column, index + 1)),
      record("BrtEndListCol")
    );
  });
  records.push(record("BrtEndListCols"));
  // **The style, last inside the collection.** Without it a table is drawn unstyled — the banding and the
  // header fill that `<tableStyleInfo>` names in the XLSX had no counterpart here.
  records.push(
    record(
      "BrtTableStyleClient",
      encodeTableStyleClient(table.style?.theme ?? DEFAULT_TABLE_STYLE, {
        firstColumn: table.style?.showFirstColumn === true,
        lastColumn: table.style?.showLastColumn === true,
        rowStripes: table.style?.showRowStripes === true,
        columnStripes: table.style?.showColumnStripes === true
      })
    )
  );
  records.push(record("BrtEndList"));
  return encodeBiffRecords(records);
}

/** Read a whole `xl/tables/table{N}.bin`, or `undefined` when it does not decode. */
export function readTablePart(
  bytes: Uint8Array,
  part: string,
  records: (bytes: Uint8Array, part: string) => Iterable<{ id: number; payload: Uint8Array }>,
  nameOf: (id: number) => string | undefined
): SheetTable | undefined {
  let header: Omit<SheetTable, "columns"> | undefined;
  const columns: TableColumnProperties[] = [];
  let autoFilterRef: string | undefined;
  let style: TableStyleProperties | undefined;
  for (const entry of records(bytes, part)) {
    const name = nameOf(entry.id);
    if (name === "BrtBeginList") {
      header = safely(() => readListHeader(entry.payload, part));
      continue;
    }
    if (name === "BrtBeginAFilter") {
      // The filter range, which is not the table's own range — see `autoFilterRange`. Recovering it means a
      // re-write keeps the range the file had rather than re-deriving one that may differ.
      autoFilterRef = safely(() =>
        rangeReference(readRange(new BinaryReader(entry.payload, 0, part)))
      );
      continue;
    }
    if (name === "BrtTableStyleClient") {
      style = safely(() => readTableStyleClient(entry.payload, part));
      continue;
    }
    if (name === "BrtBeginListCol") {
      const column = safely(() => readListColumn(entry.payload, part));
      if (column !== undefined) {
        columns.push(column);
      }
    }
  }
  if (header === undefined || columns.length === 0) {
    return undefined;
  }
  return {
    ...header,
    columns,
    ...(autoFilterRef === undefined ? {} : { autoFilterRef }),
    ...(style === undefined ? {} : { style })
  };
}

/** `BrtBeginList`: 56 fixed bytes, then six strings. */
function encodeListHeader(table: SheetTable, range: BiffRange): Uint8Array {
  const writer = new BinaryWriter();
  const display = table.displayName ?? table.name;
  const head = concatUint8Arrays([
    encodeRange(range),
    writer
      .writeUint32(LTRANGE)
      .writeUint32(table.id)
      // Both are `Boolean` — a full `u32` each, not bits in the flag word below.
      .writeUint32(table.headerRow === false ? 0 : 1)
      .writeUint32(table.totalsRow === true ? 1 : 0)
      // `fShownTotalRow` at bit 0: whether a totals row has *ever* been shown — which is not the same
      // question as whether one is shown now, and this wrote the answer to the second.
      //
      // "Ever" is unknowable from a model, so the container's own default decides it, and OOXML's is
      // **true**: `CT_Table/@totalsRowShown` defaults to `1`, and this library's XLSX writer omits the
      // attribute — so an XLSX from here says "yes" while its XLSB said "no" for the same table. Excel
      // agrees with the XLSX: its `BrtBeginList` for a table with `crwTotals = 0` still carries
      // `fShownTotalRow = 1`.
      //
      // Set unconditionally for that reason. The bit only tells Excel whether to offer the totals row as a
      // remembered state; `crwTotals` above is what actually shows or hides it.
      .writeUint32(0x01)
      // Six `DXFId`s, all "none". Zeroing them would point every table at differential format 0.
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      // `dwConnID` MUST be 0 unless `lt` is LTXML, and this writer only emits LTRANGE.
      .writeUint32(0)
      .toUint8Array()
  ]);
  return concatUint8Arrays([
    head,
    // `stName` is the programmatic identifier and `stDisplayName` the one formulas use. The
    // specification allows `stName` to be NULL, in which case `stDisplayName` serves both — but writing
    // the name is what lets a reader recover it without inferring.
    encodeNullableWideString(table.name),
    encodeNullableWideString(display),
    // `stComment` — **the empty string, not NULL.** Section 3.3.2's worked example is explicit: "The empty
    // string specifies that there is no comment." NULL is what the field is for when `fSingleCell` is 1,
    // where the specification *requires* it. Excel writes the empty string for a commentless table, and
    // this wrote NULL for every one of them.
    encodeNullableWideString(""),
    encodeNullableWideString(undefined), // stStyleHeader
    encodeNullableWideString(undefined), // stStyleData
    encodeNullableWideString(undefined) // stStyleAgg
  ]);
}

function readListHeader(payload: Uint8Array, part: string): Omit<SheetTable, "columns"> {
  const reader = new BinaryReader(payload, 0, part);
  const range = readRange(reader);
  reader.readUint32(); // lt
  const id = reader.readUint32();
  const headerRow = reader.readUint32() !== 0;
  const totalsRow = reader.readUint32() !== 0;
  reader.readUint32(); // flags
  for (let index = 0; index < 6; index++) {
    reader.readUint32(); // the six DXFIds
  }
  reader.readUint32(); // dwConnID
  const name = readNullableWideString(reader, part);
  const displayName = readNullableWideString(reader, part);
  return {
    ref: rangeReference(range),
    // `stName` NULL means the display name serves both, which the specification states directly.
    name: name ?? displayName ?? "",
    ...(displayName === undefined ? {} : { displayName }),
    headerRow,
    totalsRow,
    id
  };
}

/** `BrtBeginListCol`: 24 fixed bytes, then six strings. */
function encodeListColumn(column: TableColumnProperties, id: number): Uint8Array {
  const totals = Math.max(0, TOTALS_FUNCTION.indexOf(column.totalsRowFunction ?? "none"));
  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint32(id)
      .writeUint32(totals)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      .writeUint32(NO_DXF)
      // `idqsif` MUST be 0 unless `lt` is LTEXTDATA.
      .writeUint32(0)
      .toUint8Array(),
    // NULL for a standard table — the specification's own example says so, because `lt` is LTRANGE.
    encodeNullableWideString(undefined),
    // The header text. This is the field a reader recovers the column name from, and leaving it empty
    // produces a table with blank headers.
    encodeNullableWideString(column.name),
    // `stTotal` MUST be NULL when the function is custom, because then `BrtListTrFmla` carries it.
    encodeNullableWideString(
      column.totalsRowFunction === "custom" ? undefined : column.totalsRowLabel
    ),
    // `stStyleHeader`. Always NULL: it names a *cell style* applied to the header row, and this writer
    // does not carry one — and the specification requires NULL whenever the table shows a header row,
    // which is the common case anyway.
    encodeNullableWideString(undefined),
    encodeNullableWideString(undefined), // stStyleInsertRow
    encodeNullableWideString(undefined) // stStyleAgg
  ]);
}

function readListColumn(payload: Uint8Array, part: string): TableColumnProperties {
  const reader = new BinaryReader(payload, 0, part);
  reader.readUint32(); // idField
  const totals = reader.readUint32();
  reader.readUint32(); // nDxfHdr
  reader.readUint32(); // nDxfInsertRow
  reader.readUint32(); // nDxfAgg
  reader.readUint32(); // idqsif
  const name = readNullableWideString(reader, part);
  const caption = readNullableWideString(reader, part);
  const total = readNullableWideString(reader, part);
  const totalsRowFunction = TOTALS_FUNCTION[totals];
  return {
    // The caption is the header text; `stName` is NULL for a standard table, so it is the fallback
    // rather than the other way round.
    name: caption ?? name ?? "",
    ...(totalsRowFunction === undefined || totalsRowFunction === "none"
      ? {}
      : { totalsRowFunction }),
    ...(total === undefined ? {} : { totalsRowLabel: total })
  };
}

/**
 * The range the filter buttons cover.
 *
 * `undefined` when the table has no header row, because the buttons live in the header cells and a table
 * without one has nowhere to put them — Excel writes no `BrtBeginAFilter` in that case either.
 *
 * The model's own `autoFilterRef` wins when it has one, so a table read from XML keeps the range it came
 * with. Otherwise it is the table's range **less the totals row**: including that row puts a filter button
 * over the totals and makes the total itself filterable, which is not what a totals row is.
 */
function autoFilterRange(table: SheetTable, range: BiffRange): BiffRange | undefined {
  if (table.headerRow === false) {
    return undefined;
  }
  const stated =
    table.autoFilterRef === undefined ? undefined : tryDecodeRange(table.autoFilterRef);
  if (stated !== undefined) {
    return stated;
  }
  const lastRow = table.totalsRow === true ? range.lastRow - 1 : range.lastRow;
  // A one-row table whose only row is the totals row would give an inverted range; leave it unfiltered
  // rather than emit one that reads backwards.
  return lastRow < range.firstRow ? undefined : { ...range, lastRow };
}

/** The style `Table.add` puts in the model, and therefore what an absent style means. */
const DEFAULT_TABLE_STYLE = "TableStyleMedium2";

/** `BrtTableStyleClient` back into the model's style shape. */
function readTableStyleClient(payload: Uint8Array, part: string): TableStyleProperties {
  const reader = new BinaryReader(payload, 0, part);
  const flags = reader.readUint16();
  const theme = readWideString(reader, part);
  return {
    ...(theme === "" ? {} : { theme }),
    showFirstColumn: (flags & 0x0001) !== 0,
    showLastColumn: (flags & 0x0002) !== 0,
    showRowStripes: (flags & 0x0004) !== 0,
    showColumnStripes: (flags & 0x0008) !== 0
  };
}

function rangeReference(range: BiffRange): string {
  return encodeReference(
    { r: range.firstRow, c: range.firstColumn },
    { r: range.lastRow, c: range.lastColumn }
  );
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
