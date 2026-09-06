/**
 * The two PivotCache parts — `pivotCacheDefinition{n}.bin` and `pivotCacheRecords{n}.bin` — and the
 * `BrtBeginPivotCacheID` records in the workbook that bind a cache to its definition.
 *
 * **Not yet wired into the package writer, deliberately.** A pivot table needs all four parts at once: the
 * specification requires one PivotCache Definition part *per* `BrtBeginPivotCacheID` record in the workbook,
 * so a workbook carrying the binding without the parts is a package pointing at something that is not there —
 * which Excel offers to repair. These encoders are therefore built and tested against the specification
 * first, and the package writer starts emitting them only once the PivotTable view part joins them.
 *
 * **The record order is not guessed.** MS-XLSB section 3.8 is a fifty-seven step byte-level worked example of
 * this exact sequence. An earlier version of this module's documentation claimed no such authority existed;
 * it does, in the same chapter as the filter example that was already being relied on.
 */

import type { CacheField, SharedItemValue } from "@excel/core/pivot-table-types";
import { dateToSerial } from "@excel/xlsb/write/cells";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** One record: a name and its payload, in the order MS-XLSB 3.8 gives them. */
export type PivotRecord = readonly [string, Uint8Array | undefined];

/**
 * `DataFunctionalityLevel` 3 — the level at which a cache may carry captions longer than 255 characters and
 * a `stFldCaption` at all. Written for all three version bytes because this writer produces one shape of
 * cache and claiming a lower level would forbid fields it does emit.
 */
const CACHE_APP_VERSION = 8;
const CACHE_MIN_VERSION = 3;

/** An `XLWideString`: a four-byte character count, then UTF-16. */
function wideString(value: string): Uint8Array {
  const characters = [...value];
  const writer = new BinaryWriter().writeUint32(characters.length);
  for (const character of characters.join("")) {
    writer.writeUint16(character.charCodeAt(0));
  }
  return writer.toUint8Array();
}

/** An `RfX`: four unsigned 32-bit bounds, first row, last row, first column, last column. */
function rfx(
  rowFirst: number,
  rowLast: number,
  columnFirst: number,
  columnLast: number
): Uint8Array {
  return new BinaryWriter()
    .writeUint32(rowFirst)
    .writeUint32(rowLast)
    .writeUint32(columnFirst)
    .writeUint32(columnLast)
    .toUint8Array();
}

/**
 * `BrtBeginPivotCacheID` — MS-XLSB 2.4.169. The workbook's half of the binding.
 *
 * `idSx` is the cache identifier the PivotTable view's `BrtBeginSXView.idCache` must equal, and it must be
 * unique within the collection. `irstcacheRelID` is the workbook relationship naming the definition part —
 * a *relationship id*, not a path, which is what makes the same cache reachable from a renamed part.
 */
export function pivotCacheIdRecords(
  caches: readonly { readonly cacheId: number; readonly relationshipId: string }[]
): PivotRecord[] {
  if (caches.length === 0) {
    return [];
  }
  const records: PivotRecord[] = [
    // **Empty.** Not a count — this record has no fields at all. Section 2.4.170 lists no structure for it and
    // section 3.8.1's worked example declares its size as `0000`, which is as explicit as this document gets.
    // A four-byte count was written here, in `workbook.bin`, which is among the first things Excel parses.
    //
    // Most collections here *are* counted (`BrtBeginSXVDs` is `0004` with `csxvds`), so the shape cannot be
    // guessed from the neighbours — this repository already knew that from `BrtBeginColInfos`, which Excel
    // also writes empty while the styles collections beside it carry counts. Check the declared size per
    // record.
    ["BrtBeginPivotCacheIDs", undefined]
  ];
  for (const cache of caches) {
    records.push([
      "BrtBeginPivotCacheID",
      concatUint8Arrays([
        new BinaryWriter().writeUint32(cache.cacheId).toUint8Array(),
        wideString(cache.relationshipId)
      ])
    ]);
    records.push(["BrtEndPivotCacheID", undefined]);
  }
  records.push(["BrtEndPivotCacheIDs", undefined]);
  return records;
}

/** What a cache definition needs to describe its source and its fields. */
export interface PivotCacheModel {
  /** The sheet the source range lives on. */
  readonly sheetName: string;
  /** The source range, zero-based and inclusive. */
  readonly range: {
    readonly rowFirst: number;
    readonly rowLast: number;
    readonly columnFirst: number;
    readonly columnLast: number;
  };
  readonly cacheFields: readonly CacheField[];
  /** Source rows, already reduced to per-field cache-item indices or literal values. */
  readonly records: readonly (readonly (number | SharedItemValue)[])[];
  /** The relationship id of the records part, or `undefined` when no records part is written. */
  readonly recordsRelationshipId?: string;
}

/**
 * `pivotCacheDefinition{n}.bin`.
 *
 * ```
 * BrtBeginPivotCacheDef
 *   BrtBeginPCDSource
 *     BrtBeginPCDSRange … BrtEndPCDSRange
 *   BrtEndPCDSource
 *   BrtBeginPCDFields
 *     BrtBeginPCDField
 *       BrtBeginPCDFAtbl  BrtPCDIString×  BrtEndPCDFAtbl
 *     BrtEndPCDField      … once per field
 *   BrtEndPCDFields
 * BrtEndPivotCacheDef
 * ```
 */
export function pivotCacheDefinitionRecords(cache: PivotCacheModel): PivotRecord[] {
  const records: PivotRecord[] = [
    ["BrtBeginPivotCacheDef", cacheDefinitionPayload(cache)],
    // `iSrcType` 0 is a worksheet range; `dwConnID` is ignored for it but still occupies its four bytes.
    ["BrtBeginPCDSource", new BinaryWriter().writeUint32(0).writeUint32(0).toUint8Array()],
    ["BrtBeginPCDSRange", sourceRangePayload(cache)],
    ["BrtEndPCDSRange", undefined],
    ["BrtEndPCDSource", undefined],
    ["BrtBeginPCDFields", new BinaryWriter().writeUint32(cache.cacheFields.length).toUint8Array()]
  ];
  cache.cacheFields.forEach((field, index) => {
    records.push(["BrtBeginPCDField", cacheFieldPayload(field)]);
    // **Every field gets this collection, including one with no shared items.** It used to be written only for
    // a field that had items, on the reasoning that a field without them stores its values inline in each
    // cache record and so has nothing to collect. That reasoning contradicted the comment on
    // `sharedItemsPayload` two functions below, which had already worked out that `BrtPCRRecord` carries no
    // per-item tag and that a reader recovers the type of an inline value *from these flags*. A field with
    // inline values therefore needs them more than one with items does — without them nothing says whether
    // its four-or-eight bytes are an index or an `Xnum`, and the whole cache record stream is unparseable.
    // Excel's answer was to refuse the workbook outright.
    //
    // This library's own XLSX writer had it right for the same model: `<cacheField name="Units">` carries a
    // `<sharedItems containsNumber="1" containsInteger="1" minValue="10" maxValue="20"/>` with no items in
    // it. The two writers disagreeing about one model is what made the defect findable without Excel.
    const items = field.sharedItems ?? undefined;
    records.push([
      "BrtBeginPCDFAtbl",
      items === undefined ? inlineFieldTypePayload(cache.records, index) : sharedItemsPayload(items)
    ]);
    for (const item of items ?? []) {
      records.push(sharedItemRecord(item));
    }
    records.push(["BrtEndPCDFAtbl", undefined]);
    records.push(["BrtEndPCDField", undefined]);
  });
  records.push(["BrtEndPCDFields", undefined]);
  records.push(["BrtEndPivotCacheDef", undefined]);
  return records;
}

/**
 * `BrtBeginPivotCacheDef` — MS-XLSB 2.4.168.
 *
 * ```
 * bVerCacheLastRefresh      u8
 * bVerCacheRefreshableMin   u8
 * bVerCacheCreated          u8
 * fSaveData … fSheetData    u8   eight one-bit flags
 * citmGhostMax              i32
 * xnumRefreshedDate         8    a date as an Xnum
 * fLoadRefreshedWho … res   u8   four flags then four reserved bits
 * cRecords                  u32
 * stRefreshedWho            —    iff fLoadRefreshedWho
 * stRelIDRecords            —    iff fLoadRelIDRecords
 * unused                    u32  iff **not** fLoadRefreshedWho
 * ```
 *
 * **That last line is the trap.** The four unused bytes exist *if and only if* `fLoadRefreshedWho` is 0, so a
 * writer that omits the user name must still write them — omitting both leaves the record four bytes short
 * and every subsequent field of the part misaligned. It reads as a presence flag but behaves as padding.
 */
function cacheDefinitionPayload(cache: PivotCacheModel): Uint8Array {
  const hasRecords = cache.recordsRelationshipId !== undefined;
  const writer = new BinaryWriter()
    // `bVerCacheLastRefresh`, `bVerCacheRefreshableMin`, `bVerCacheCreated` — 8, 3, 8, which is what Excel
    // writes and what this library's XLSX writer declares (`refreshedVersion="8" minRefreshableVersion="3"
    // createdVersion="8"`). All three were 3, claiming an Excel 2007 cache.
    .writeUint8(CACHE_APP_VERSION)
    .writeUint8(CACHE_MIN_VERSION)
    .writeUint8(CACHE_APP_VERSION)
    // `fSaveData` when a records part is written, `fRefreshOnLoad`, and `fEnableRefresh` so the cache can be
    // refreshed. The rest are for OLAP or ODBC sources and MUST be 0 for a worksheet range.
    //
    // **`fRefreshOnLoad` is not optional for this writer.** The view records it produces carry a *minimal*
    // layout — one grand-total `BrtSXLI` rather than a row item per value — exactly as this library's XLSX
    // writer does, and that writer sets `refreshOnLoad="1"` unconditionally with the note "important for our
    // implementation to work". Its `pivot-table-xform` says why: Excel expands the layout itself on refresh.
    // Emitting the minimal layout *without* asking for the refresh, as this did, hands Excel an incomplete
    // pivot table and tells it the cache is current.
    .writeUint8((hasRecords ? 0x01 : 0) | 0x04 | 0x10)
    // -1 asks the application to balance memory against future use, rather than discarding every unused
    // cache item on the next refresh, which is what 0 means.
    .writeUint32(0xffffffff)
    // The refresh date. 0 rather than a clock reading: a timestamp would make two writes of the same
    // workbook differ, which the round-trip tests compare byte for byte.
    .writeFloat64(0)
    // `fLoadRelIDRecords` at bit 1, which MUST be 1 when `fSaveData` is 1. `fLoadRefreshedWho` stays 0.
    .writeUint8(hasRecords ? 0x02 : 0)
    .writeUint32(cache.records.length);
  const parts: Uint8Array[] = [writer.toUint8Array()];
  if (hasRecords) {
    parts.push(wideString(cache.recordsRelationshipId!));
  }
  // Present because `fLoadRefreshedWho` is 0 — see the note above.
  parts.push(new BinaryWriter().writeUint32(0).toUint8Array());
  return concatUint8Arrays(parts);
}

/**
 * `BrtBeginPCDSRange` — MS-XLSB 2.4.167. Three flag bytes, the sheet name, then the range.
 *
 * The order is flags → name → range, which the worked example in 3.8.5 gives directly. Each flag occupies a
 * whole byte with its own reserved bits rather than sharing one, which is why there are three and not one.
 */
function sourceRangePayload(cache: PivotCacheModel): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter()
      // `fName` — the source is a range, not a defined name.
      .writeUint8(0)
      // `fBuiltIn` — ignored when `fName` is 0, but its byte is not optional.
      .writeUint8(0)
      // `fLoadRelId` 0 (not an external workbook) with `fLoadSheet` at bit 1: the source is scoped to a
      // single sheet, which is what makes `sheetName` meaningful.
      .writeUint8(0x02)
      .toUint8Array(),
    wideString(cache.sheetName),
    rfx(cache.range.rowFirst, cache.range.rowLast, cache.range.columnFirst, cache.range.columnLast)
  ]);
}

/**
 * `BrtBeginPCDField` — MS-XLSB 2.4.136. Twenty fixed bytes, then the field name.
 *
 * `fSrcField` is set for every field this writer emits: the specification requires it on the first field and
 * requires every field without it to come last, and a field derived from a source column is a source field
 * by definition. `ifmt`, `wTypeSql`, `ihdb` and `isxtl` are all OLAP or ODBC concerns that MUST be 0 here.
 */
function cacheFieldPayload(field: CacheField): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter()
      // Byte 1: fServerBased, fCantGetUniqueItems, fSrcField, fCaption, fOlapMemPropField, 3 reserved.
      .writeUint8(0x04)
      // Byte 2: fLoadFmla, fLoadPropName, 6 reserved. No calculated fields, no member properties.
      .writeUint8(0)
      .writeUint32(Number(field.numFmtId ?? 0))
      .writeUint16(0)
      .writeUint32(0)
      .writeUint32(0)
      // `cIsxtmps` — member-property field indices, which only an OLAP cache has.
      .writeUint32(0)
      .toUint8Array(),
    wideString(field.name)
  ]);
}

/**
 * `BrtBeginPCDFAtbl` — MS-XLSB 2.4.131. A flag word describing what the items *are*, then their count.
 *
 * The flags are not decoration: `BrtPCRRecord` reads them to decide how an inline value in a cache record is
 * typed — `fNumField` means an `Xnum`, `fDateInField` without `fHasTextItem` means a `PCDIDateTime`, and
 * anything else is a string. So they are derived from the items actually present rather than copied from the
 * model's preserved attribute strings, which describe the *XLSX* form and may be absent entirely.
 *
 * `fNumMinMaxValid` stays 0 and no bounds follow. The two `Xnum` are optional on that flag, and writing them
 * for a field whose items are text would describe a range that does not exist. A field whose values are
 * inline rather than collected here goes through `inlineFieldTypePayload`, which does write them.
 */
/**
 * Bit 10 of `BrtBeginPCDFAtbl`'s flags, which Excel sets on every field.
 *
 * All nine records across the oracle's reference workbooks carry it whatever the field holds, so it says nothing about
 * the content; the specification's field table has nothing at that position. It was named because two functions wrote
 * this record and a literal in one of them is how they came to disagree — and now there is one function, which is the
 * fix that comment was asking for.
 */
const ALWAYS_SET = 0x0400;

/**
 * What a cache field's values *are*, as `BrtBeginPCDFAtbl`'s flag word states it.
 *
 * **One function, because there are two callers and they disagreed twice.** The record is written from two places — a
 * field whose values are enumerated (`sharedItemsPayload`) and one whose values sit inline in each `BrtPCRRecord`
 * (`inlineFieldTypePayload`) — and each computed these nine bits itself. The comments in this file record both
 * consequences: bit 10 was added to one and not the other, leaving `0x05c2` against `0x01c2` for the same numeric field;
 * and the bounds predicate included dates in one and not the other, so a single date column claimed a range in the cache
 * that listed it and no range in the cache that did not. The second of those was found by Excel's own bytes disagreeing
 * with *this library's own other output*, which is a stronger signal than disagreeing with Excel.
 *
 * The two callers still differ in one honest way — `citems` is the item count for the first and always 0 for the second —
 * and that stays theirs to write.
 */
function fieldTypeFlags(kinds: {
  readonly hasText: boolean;
  readonly hasBlank: boolean;
  readonly hasNumber: boolean;
  readonly hasDate: boolean;
  readonly allInteger: boolean;
}): { readonly flags: number; readonly bounded: boolean } {
  const { hasText, hasBlank, hasNumber, hasDate, allInteger } = kinds;
  // "More than one of text, numeric or date", blanks not counting.
  const mixed = [hasText, hasNumber, hasDate].filter(Boolean).length > 1;
  // **Bounds for a field that is purely numeric *or* purely dates.** Excel writes `fNumMinMaxValid` with the earliest
  // and latest as serial numbers for a date field exactly as it does for a numeric one — a date is a number as far as a
  // range is concerned. A mixed field gets none: a range over values that are not all comparable describes something
  // that is not there, and the flag would be a false claim rather than a bound.
  const bounded = (hasNumber || hasDate) && !hasText && !mixed;
  const flags =
    (hasText || hasBlank ? 0x0001 : 0) |
    (hasText || hasBlank || hasNumber ? 0x0002 : 0) |
    (hasDate ? 0x0004 : 0) |
    (hasText ? 0x0008 : 0) |
    (hasBlank ? 0x0010 : 0) |
    (mixed ? 0x0020 : 0) |
    (hasNumber ? 0x0040 : 0) |
    (hasNumber && allInteger ? 0x0080 : 0) |
    (bounded ? 0x0100 : 0) |
    // **Bit 10, which Excel sets on every field.** All nine `BrtBeginPCDFAtbl` records across the oracle's reference
    // workbooks carry it — `0x040b`, `0x05c2`, `0x0504` — whether the field holds text, numbers or dates, so it is not
    // describing the content. The specification's field table has nothing at that position, which makes it one of the
    // bits it calls unused and tells a reader to ignore. Matched rather than left clear on the same grounds as
    // `BrtWsProp`'s constants elsewhere in this writer: a bit Excel writes unconditionally costs nothing to reproduce.
    ALWAYS_SET;
  return { flags, bounded };
}

/**
 * Classifies a field's values, for {@link fieldTypeFlags}.
 *
 * `null` and `""` are both blank: the model uses `null` for a missing value and the empty string survives from a cell
 * that held one, and `<sharedItems containsBlank="1"/>` is the same claim either way.
 */
function classifyValues(values: Iterable<unknown>): {
  hasText: boolean;
  hasBlank: boolean;
  hasNumber: boolean;
  hasDate: boolean;
  allInteger: boolean;
  numbers: number[];
  dates: Date[];
} {
  const out = {
    hasText: false,
    hasBlank: false,
    hasNumber: false,
    hasDate: false,
    allInteger: true,
    numbers: [] as number[],
    dates: [] as Date[]
  };
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      out.hasBlank = true;
    } else if (typeof value === "number") {
      out.hasNumber = true;
      out.numbers.push(value);
      out.allInteger = out.allInteger && Number.isInteger(value);
    } else if (value instanceof Date) {
      out.hasDate = true;
      out.dates.push(value);
    } else {
      out.hasText = true;
    }
  }
  return out;
}

/**
 * The bounds `fNumMinMaxValid` promises: `xnumMin` then `xnumMax`.
 *
 * **A half-open interval over whole days for dates**: the first day's start and the day *after* the last one. Excel
 * writes 45377 for a field whose latest date is 45376, which is not the latest value and is exactly the end of the last
 * day — so a value inside that day, 45376.5 say, falls within the range. Writing the latest value itself puts the
 * afternoon of the final day outside the bounds the field declares. `Math.floor` makes the two agree when a date does
 * carry a time.
 */
function boundsFor(kinds: { numbers: readonly number[]; dates: readonly Date[] }): {
  readonly min: number;
  readonly max: number;
} {
  if (kinds.dates.length > 0) {
    const serials = kinds.dates.map(date => dateToSerial(date, false));
    return { min: Math.min(...serials), max: Math.floor(Math.max(...serials)) + 1 };
  }
  return { min: Math.min(...kinds.numbers), max: Math.max(...kinds.numbers) };
}

/**
 * `BrtBeginPCDFAtbl` for a field whose values are *enumerated* — `citems` is the item count.
 */
function sharedItemsPayload(items: readonly SharedItemValue[]): Uint8Array {
  const kinds = classifyValues(items);
  // **`hasDate` without a listed date is still a date field.** A cache field can declare what it contains and list no
  // items — that is what `citems: 0` means — so requiring a non-empty date array made the same field claim a range in
  // one cache and none in another: `05-pivots` produced `0x0004` and `0x0104` for one date column across three caches,
  // which is this library disagreeing with itself.
  const { flags, bounded } = fieldTypeFlags(kinds);
  const writer = new BinaryWriter().writeUint16(flags).writeUint32(items.length);
  if (bounded) {
    const { min, max } = boundsFor(kinds);
    writer.writeFloat64(min).writeFloat64(max);
  }
  return writer.toUint8Array();
}

/**
 * `BrtBeginPCDFAtbl` for a field whose values sit inline in each `BrtPCRRecord` rather than in a collection.
 *
 * `citems` is 0 — there is no collection to count — and the flags are what tell a reader how to read those inline
 * values, so they matter *more* here than for an enumerated field, not less.
 */
function inlineFieldTypePayload(rows: PivotCacheModel["records"], index: number): Uint8Array {
  const kinds = classifyValues(rows.map(row => row[index]));
  const { flags, bounded } = fieldTypeFlags(kinds);
  const writer = new BinaryWriter().writeUint16(flags).writeUint32(0);
  if (bounded) {
    const { min, max } = boundsFor(kinds);
    writer.writeFloat64(min).writeFloat64(max);
  }
  return writer.toUint8Array();
}

/** One cache item, as the record that matches its type. */
function sharedItemRecord(item: SharedItemValue): PivotRecord {
  if (item === null || item === "") {
    return ["BrtPCDIMissing", undefined];
  }
  if (typeof item === "number") {
    return ["BrtPCDINumber", new BinaryWriter().writeFloat64(item).toUint8Array()];
  }
  if (typeof item === "boolean") {
    return ["BrtPCDIBoolean", new BinaryWriter().writeUint8(item ? 1 : 0).toUint8Array()];
  }
  if (item instanceof Date) {
    return ["BrtPCDIDatetime", encodePcdiDateTime(item)];
  }
  // A value none of the above: written as text. `String(item)` on a `Date` is what used to happen here, and
  // it put `"Mon Jan 15 2024 00:00:00 GMT+0800 (China Standard Time)"` into the cache — a sentence whose
  // content depends on the machine's locale and timezone.
  return ["BrtPCDIString", wideString(String(item))];
}

/**
 * `PCDIDateTime`, MS-XLSB 2.5.101 — a calendar date and a wall-clock time, not a serial number.
 *
 * Eight bytes: `yr` and `mon` as `u16`, then `dom`, `hr`, `min`, `sec` one byte each. Read in **UTC**, because
 * the value in the model came from a spreadsheet cell rather than from a moment in time: reading it locally
 * would shift every date by the writer's timezone offset, which is how the string form above went wrong.
 */
function encodePcdiDateTime(date: Date): Uint8Array {
  return new BinaryWriter()
    .writeUint16(date.getUTCFullYear())
    .writeUint16(date.getUTCMonth() + 1)
    .writeUint8(date.getUTCDate())
    .writeUint8(date.getUTCHours())
    .writeUint8(date.getUTCMinutes())
    .writeUint8(date.getUTCSeconds())
    .toUint8Array();
}

/**
 * `pivotCacheRecords{n}.bin`.
 *
 * ```
 * BrtBeginPivotCacheRecords
 *   BrtPCRRecord  … one per source row
 * BrtEndPivotCacheRecords
 * ```
 *
 * A `BrtPCRRecord` is a bare sequence with no per-item tag: each element is four bytes of cache-item index
 * when the corresponding field has a `BrtBeginPCDFAtbl` collection, and the literal value otherwise. There
 * is nothing in the record saying which — the reader recovers it from the field's flags, which is why
 * `sharedItemsPayload` derives those from the items rather than trusting the model's XLSX attributes.
 */
export function pivotCacheRecordsRecords(cache: PivotCacheModel): PivotRecord[] {
  const records: PivotRecord[] = [
    [
      "BrtBeginPivotCacheRecords",
      new BinaryWriter().writeUint32(cache.records.length).toUint8Array()
    ]
  ];
  for (const row of cache.records) {
    records.push(["BrtPCRRecord", cacheRecordPayload(row, cache.cacheFields)]);
  }
  records.push(["BrtEndPivotCacheRecords", undefined]);
  return records;
}

/** One source row: an index per shared-item field, an inline value per field without them. */
function cacheRecordPayload(
  row: readonly (number | SharedItemValue)[],
  fields: readonly CacheField[]
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const value = row[index];
    const shared = fields[index]?.sharedItems;
    if (shared !== null && shared !== undefined) {
      // An index. A value out of range would point at a cache item that does not exist, so it is clamped
      // rather than written — an out-of-range index is a corrupt record, not a lossy one.
      const numeric = typeof value === "number" ? value : 0;
      const bounded = Math.max(0, Math.min(shared.length - 1, Math.trunc(numeric)));
      parts.push(new BinaryWriter().writeUint32(bounded).toUint8Array());
      continue;
    }
    if (typeof value === "number") {
      parts.push(new BinaryWriter().writeFloat64(value).toUint8Array());
      continue;
    }
    if (value instanceof Date) {
      // **Eight structured bytes, not `Date.prototype.toString()`.** Falling through to the string branch below
      // wrote `"Mon Jan 15 2024 11:00:00 GMT+1100 (Australian Eastern Daylight Time)"` into the cache record —
      // 152 bytes of locale- and timezone-dependent English where Excel writes a `PCDIDateTime`. The field's
      // `BrtBeginPCDFAtbl` already declares `fDateInField`, so a reader is told to expect eight bytes and found
      // a length-prefixed string instead, which desynchronises every field after it in the row.
      //
      // This is the same defect as the one fixed in the cache *definition*'s shared items, in the second place
      // it occurs. Fixing one and not the other is what `String(value)` on a union containing `Date` invites:
      // the compiler is satisfied, and `Date` has a `toString`.
      parts.push(encodePcdiDateTime(value));
      continue;
    }
    parts.push(wideString(value === null || value === undefined ? "" : String(value)));
  }
  return concatUint8Arrays(parts);
}
