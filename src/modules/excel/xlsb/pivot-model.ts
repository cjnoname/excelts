/**
 * The bridge from the workbook's `PivotTable` model to the four binary parts.
 *
 * Kept apart from the two encoders because it is the only place that knows about the *model* — the encoders
 * take the shapes they need and nothing else, which is what let them be tested against `[MS-XLSB]` field
 * tables rather than against a workbook.
 *
 * This is also where the cross-part invariants are established, and they are the reason a pivot table cannot
 * be assembled a part at a time:
 *
 * - `idSx` in the workbook binding must equal `idCache` in the view.
 * - `cRecords` in the cache definition must equal the number of `BrtPCRRecord` records written.
 * - Every index in a cache record must be within its field's `BrtBeginPCDFAtbl` collection.
 * - The view must carry one pivot field per *cache* field, because the axis collections index into it.
 */

import type { PivotTable } from "@excel/core/pivot-table";
import {
  METRIC_DISPLAY_NAMES,
  VALID_SUBTOTALS,
  type PivotTableSubtotal,
  type RecordValue,
  type SharedItemValue
} from "@excel/core/pivot-table-types";
import { decodeCell } from "@excel/utils/address";
import type { PivotCacheModel } from "@excel/xlsb/pivot-cache";
import {
  PIT_DATA,
  PIT_DEFAULT,
  PIT_GRAND,
  type PivotLine,
  type PivotViewModel
} from "@excel/xlsb/pivot-view";

/** Both halves of one pivot table, ready to encode. */
export interface PivotParts {
  readonly cache: PivotCacheModel;
  readonly view: PivotViewModel;
}

/**
 * Reduce one source value to what a cache record holds for it: an index into the field's shared items, or the
 * value itself when the field has none.
 *
 * A value that is not among the shared items would be an index into nothing, so it falls back to 0 rather
 * than being written as an out-of-range index — `pivot-cache.ts` clamps as a second line of defence, and this
 * is the first.
 */
function cacheRecordValue(
  value: unknown,
  sharedItems: readonly SharedItemValue[] | null
): number | SharedItemValue {
  if (sharedItems === null) {
    if (value === null || value === undefined) {
      return "";
    }
    // **A `Date` is carried through, not stringified.** `String(aDate)` is where the cache record's
    // 152-byte `"Mon Jan 15 2024 11:00:00 GMT+1100 (Australian Eastern Daylight Time)"` came from — locale- and
    // timezone-dependent English in place of the eight structured bytes of a `PCDIDateTime`. The field's
    // `BrtBeginPCDFAtbl` declares `fDateInField`, so a reader is told to expect eight bytes and finds a
    // length-prefixed string, which desynchronises every field after it in the row.
    //
    // The `String()` fallback stays for genuinely unmodelled types, and that is exactly the hazard it created:
    // `Date` has a `toString`, so the compiler was satisfied and the value silently degraded. `SharedItemValue`
    // already includes `Date` — the type allowed the right thing all along.
    if (value instanceof Date) {
      return value;
    }
    return typeof value === "number" || typeof value === "string" ? value : String(value);
  }
  const normalized =
    value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? null : value;
  const index = sharedItems.findIndex(item => {
    if (item instanceof Date && normalized instanceof Date) {
      return item.getTime() === normalized.getTime();
    }
    return item === normalized;
  });
  return index >= 0 ? index : 0;
}

/**
 * Which axis a field sits on, from the model's three index lists.
 *
 * The lists are not exclusive: the model allows a field in both `rows` and `values`, and Excel does too. The
 * record's `sxaxis` treats row, column and page as mutually exclusive but the data axis as a separate bit, so
 * the row placement wins *here* and the data axis is reported alongside it through the view field's separate
 * `dataField` flag — which together are the `axis="axisRow" dataField="1"` pair the XLSX writer emits.
 *
 * This function used to be the whole answer, and the sentence above used to end at "still appears as a data
 * item" with nothing implementing it: `sxaxis` received one bit, so a field in both `rows` and `values` was
 * written as a row field that no record identified as summarised, and Excel repaired the view.
 */
function axisOf(index: number, pivot: PivotTable): PivotViewModel["fields"][number]["axis"] {
  if (pivot.rows.includes(index)) {
    return "row";
  }
  if (pivot.columns.includes(index)) {
    return "column";
  }
  if ((pivot.pages ?? []).includes(index)) {
    return "page";
  }
  if (pivot.values.includes(index)) {
    return "data";
  }
  return "none";
}

/**
 * A subtotal name the record's enumeration knows, or `sum`.
 *
 * Validated against the model's own `VALID_SUBTOTALS` rather than a list repeated here. A second copy of
 * eleven names is how `stdDevP` came to be spelled `stdDevp` in this file and silently aggregate as a sum.
 */
function subtotalAt(pivot: PivotTable, position: number): PivotTableSubtotal {
  const named = pivot.valueMetrics?.[position] ?? pivot.metric;
  return typeof named === "string" && VALID_SUBTOTALS.has(named)
    ? (named as PivotTableSubtotal)
    : "sum";
}

/**
 * Turn one `PivotTable` into the cache and view models.
 *
 * @param recordsRelationshipId - The relationship id the cache definition uses to name its records part.
 * @returns `undefined` when the model has no source to read rows from, which is the case for a pivot table
 *   this reader carried through as opaque bytes rather than modelled.
 */
export function pivotParts(
  pivot: PivotTable,
  recordsRelationshipId: string
): PivotParts | undefined {
  if (pivot.cacheFields.length === 0) {
    return undefined;
  }
  const cache = pivotCache(pivot, recordsRelationshipId);
  if (cache === undefined) {
    return undefined;
  }
  // `decodeCell` rather than a regex here: it is the module's own address parser and already yields
  // zero-based coordinates. A second one written for this file would be a second set of rules for `$A$3`.
  const anchor = decodeCell((pivot.ref ?? "A3").split(":")[0]!);
  // **The page-filter area sits above the body, and the body's own range has to start below it.**
  //
  // `ref` anchors the whole displayed block — filters, then a blank separator, then the table — but the range
  // this record carries addresses the *body* only. Each page field takes a row and the separator takes one
  // more, so the body begins `pageOffset` rows down. This was `anchor.r` outright, so a pivot with page
  // filters described a body overlapping its own filter rows: Excel removed the part for two or more page
  // fields and repaired it for one.
  //
  // The expression is the XLSX writer's, deliberately to the letter — it computes `startRow = addr.row +
  // pageOffset` from the same `pageCount > 0 ? pageCount + 1 : 0`, and that writer's output is the one Excel
  // accepts. Two containers describing one model's geometry differently is how this went unnoticed.
  const pageCount = (pivot.pages ?? []).length;
  const pageOffset = pageCount > 0 ? pageCount + 1 : 0;
  const bodyRow = anchor.r + pageOffset;
  const view: PivotViewModel = {
    name: pivot.name ?? `PivotTable${pivot.tableNumber}`,
    cacheId: Number(pivot.cacheId),
    location: {
      rowFirst: bodyRow,
      // The body's extent: down to the last enumerated pivot line, starting where the data starts.
      //
      // **This claimed the geometry and the line count were "derived from the same number" and they were not.**
      // The geometry used `enumeratedRowLineCount`, which multiplies each row field's item count — a *cross
      // product* — while the line records come from `rowLinesFromRecords`, which enumerates only the
      // combinations the data actually contains. For two row fields over three source rows that is 3×3+1 = 10
      // against the true 7, so the body claimed three rows it never fills. The two now come from one call.
      //
      // Counted from `rwFirstData` rather than from `rwFirst`, so a column field's header row is included: the
      // data begins below it and the body has to end that much lower. All three oracle pivots agree with Excel
      // on this formula — one row field (6), two row fields (9), and one of each (7).
      rowLast: bodyRow + 1 + pivot.columns.length + rowLineCount(pivot, cache.records) - 1,
      columnFirst: anchor.c,
      // **The row area is as wide as it has row fields.** This counted one column for it however many there
      // were, so a pivot with two row fields described itself one column narrower than it is — and that
      // contradicted this writer's own `fCompactData`, which it leaves *clear*: a tabular layout gives each row
      // field its own column, and only a compact one nests them into a single column. Excel's binary for the
      // two-row-field case spans two row columns, which is the same statement from the other side.
      //
      // Expressed as one number here and consumed by `locationPayload` for `colFirstData`, because the body's
      // right edge and where its data begins are the same fact counted from two ends. They were computed
      // independently and disagreed.
      // **Column fields widen the body, one enumerated column line at a time.** With none, the value fields sit
      // side by side and this is `values.length` columns. With them, each combination of column items gets its
      // own set of value columns and the grand total gets one more — which is the same enumeration the row axis
      // uses, counted along the other axis, so `enumeratedRowLineCount` serves both by taking the field list as
      // a parameter. Without this a pivot with a column field described itself as one column wide.
      columnLast:
        anchor.c +
        rowAreaWidth(pivot) -
        1 +
        Math.max(1, columnAreaWidth(pivot) * Math.max(1, pivot.values.length))
    },
    rowAreaWidth: rowAreaWidth(pivot),
    // One header row per column field, above the data. A single column field puts its items on their own row,
    // so the data starts one row lower than it does without one.
    columnFieldCount: pivot.columns.length,
    fields: pivot.cacheFields.map((field, index) => ({
      name: field.name,
      // Straight from the cache field. A value field carries `sharedItems: null` — the model's own way of
      // saying its values are aggregated rather than listed — so it yields 0 without a special case. There
      // was one here, keyed on the axis, and it was dead code that read as a rule.
      itemCount: field.sharedItems?.length ?? 0,
      // Display order, which is what the pivot field references — see `itemOrder` in `pivot-view.ts` for why this is not
      // the cache's order. Sorted by the item's own value, with blanks last, which is what Excel shows.
      ...(field.sharedItems === null || field.sharedItems === undefined
        ? {}
        : { itemOrder: displayOrder(field.sharedItems) }),
      axis: axisOf(index, pivot),
      // Independent of `axis`, because `sxaxisData` is an independent bit. A field in both `rows` and
      // `values` gets `sxaxisRw | sxaxisData`, matching the `axis="axisRow" dataField="1"` pair the XLSX
      // writer emits for the same model.
      dataField: pivot.values.includes(index)
    })),
    rowFields: [...pivot.rows],
    rowLines: rowLinesFromRecords(pivot.rows, cache.records, pivot.cacheFields),
    columnFields: [...pivot.columns],
    columnLines: rowLinesFromRecords(pivot.columns, cache.records, pivot.cacheFields),
    pageFields: [...(pivot.pages ?? [])],
    dataItems: pivot.values.map((field, position) => {
      const subtotal = subtotalAt(pivot, position);
      return {
        field,
        subtotal,
        caption:
          pivot.dataFields?.[position]?.name ??
          `${METRIC_DISPLAY_NAMES[subtotal]} of ${pivot.cacheFields[field]?.name ?? ""}`
      };
    }),
    dataCaption: "Values"
  };
  return { cache, view };
}

/**
 * How many pivot lines the row axis will show: every combination of the row fields' items, plus the grand
 * total. Mirrors `rowAxisLines` in `pivot-view`, which builds the lines themselves — the count is needed here
 * because `BrtBeginSXLocation` has to span them and it is written from the model.
 */
function enumeratedRowLineCount(pivot: {
  readonly rows: readonly number[];
  readonly cacheFields: readonly { readonly sharedItems?: readonly unknown[] | null }[];
}): number {
  let lines = 1;
  for (const field of pivot.rows) {
    const items = pivot.cacheFields[field]?.sharedItems;
    if (items === null || items === undefined || items.length === 0) {
      return 1;
    }
    lines *= items.length;
  }
  return lines + 1;
}

/**
 * How many columns the row area occupies.
 *
 * One per row field, because this writer leaves `fCompactData` clear — a tabular layout. A compact layout nests
 * every row field into a single column, and if that flag is ever set this has to become 1.
 *
 * At least one even with no row fields: the body still has a left edge.
 */
function rowAreaWidth(pivot: { readonly rows: readonly number[] }): number {
  return Math.max(1, pivot.rows.length);
}

/**
 * How many pivot lines the row axis enumerates — the number the line records will actually carry.
 *
 * `rowLinesFromRecords` is the authority, because it walks the cache records and so counts only combinations
 * that exist. It returns an empty list when the records cannot supply indices, and the caller falls back to the
 * cross-product estimate — the same fallback `rowAxisLines` uses, so the geometry and the records stay in step
 * whichever path is taken.
 */
function rowLineCount(
  pivot: {
    readonly rows: readonly number[];
    readonly cacheFields: readonly { readonly sharedItems?: readonly unknown[] | null }[];
  },
  records: PivotCacheModel["records"]
): number {
  const enumerated = rowLinesFromRecords(pivot.rows, records, pivot.cacheFields);
  return enumerated.length > 0 ? enumerated.length : enumeratedRowLineCount(pivot);
}

/**
 * How many sets of value columns the column axis produces.
 *
 * One per enumerated column line — every combination of column items that the data contains, plus the grand
 * total — or 1 when there are no column fields, in which case the value fields simply sit side by side.
 */
function columnAreaWidth(pivot: {
  readonly columns: readonly number[];
  readonly cacheFields: readonly { readonly sharedItems?: readonly unknown[] | null }[];
}): number {
  if (pivot.columns.length === 0) {
    return 1;
  }
  return enumeratedRowLineCount({ rows: pivot.columns, cacheFields: pivot.cacheFields });
}

/**
 * The row axis's pivot lines, worked out from the cache records rather than from the field list.
 *
 * Excel enumerates the combinations of row-field items that **actually occur**, in item order, and puts a
 * `PITDEFAULT` subtotal after each outer group when more than one field is on the axis. For three source rows
 * over two row fields that is seven lines; the cross product of the two fields' items is nine, six of which
 * name pairs the data does not contain.
 *
 * A single row field gets no subtotals — verified against Excel, whose two-item single-field pivot has exactly
 * `[0]`, `[1]` and the grand total.
 *
 * Returns an empty array when the records cannot supply indices, and the caller falls back.
 */
function rowLinesFromRecords(
  rowFields: readonly number[],
  records: PivotCacheModel["records"],
  // `unknown[]` because one caller only wants the line *count* and holds a looser type; `displayOrder` reads the
  // values, so the narrowing happens there.
  cacheFields: readonly { readonly sharedItems?: readonly unknown[] | null }[]
): PivotLine[] {
  if (rowFields.length === 0 || records.length === 0) {
    return [];
  }
  /**
   * The outermost field's item index expressed as a **display position**; every inner field keeps its cache index.
   *
   * That asymmetry is Excel's, and it is worth stating precisely because it looks like an inconsistency. For `TwoRows`
   * over `APAC/EMEA/AMER` × three dates, Excel writes `[0,2] [1,0] [2,1]`. Neither pure convention explains those:
   * cache indices throughout give `[0,0] [1,1] [2,2]`, and display positions throughout give `[0,2] [1,0] [2,1]` only
   * because this cache's dates happen to be in ascending order already. Deriving both readings and comparing them
   * against all three lines is what settled it — the outer index is the line's position on the axis, which is a
   * display concept, and the inner ones identify values, which is a cache concept.
   *
   * Getting this wrong is not cosmetic: `[0,0]` pairs AMER with January because both are first in their own ordering.
   *
   * A single row field cannot tell the two apart, since the only field is also the sort key — which is why this went
   * unnoticed until a pivot with two of them was compared.
   */
  const outerDisplayPosition = ((): readonly number[] | undefined => {
    const field = rowFields[0];
    const items =
      field === undefined
        ? undefined
        : (cacheFields[field]?.sharedItems as readonly SharedItemValue[] | null | undefined);
    if (items === null || items === undefined) {
      return undefined;
    }
    const order = displayOrder(items);
    // `order` lists cache indices in display order; invert it to map a cache index to its position.
    const inverted = new Array<number>(items.length).fill(0);
    order.forEach((cacheIndex, position) => {
      inverted[cacheIndex] = position;
    });
    return inverted;
  })();

  // Every row's tuple of item indices, in field order. A field whose values are inline rather than indexed has
  // no index to give, so the whole enumeration is abandoned rather than half-built.
  const tuples: number[][] = [];
  for (const row of records) {
    const tuple: number[] = [];
    for (const field of rowFields) {
      const value = row[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return [];
      }
      // Only the outermost index becomes a display position — see `outerDisplayPosition`.
      tuple.push(
        tuple.length === 0 && outerDisplayPosition !== undefined
          ? (outerDisplayPosition[value] ?? value)
          : value
      );
    }
    tuples.push(tuple);
  }
  // Distinct, ordered by index at each level — which is the order the items themselves are in, and so the order
  // Excel displays them.
  const seen = new Set<string>();
  const distinct = tuples
    .filter(tuple => {
      const key = tuple.join(",");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      for (let level = 0; level < left.length; level += 1) {
        const difference = (left[level] ?? 0) - (right[level] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    });

  const lines: PivotLine[] = [];
  const nested = rowFields.length > 1;
  distinct.forEach((tuple, index) => {
    lines.push({ itemType: PIT_DATA, indices: tuple });
    // A subtotal closes each outer group: emitted when the next line starts a different outer item, or when
    // this is the last one.
    if (!nested) {
      return;
    }
    const next = distinct[index + 1];
    if (next === undefined || next[0] !== tuple[0]) {
      lines.push({ itemType: PIT_DEFAULT, indices: [tuple[0] ?? 0] });
    }
  });
  lines.push({ itemType: PIT_GRAND, indices: [0] });
  return lines;
}

/**
 * The cache a pivot's records and source range come from — from a live worksheet, or from a parsed cache.
 *
 * **Two shapes reach this writer and only one used to be handled.** A pivot created through `Pivot.add`
 * carries `source`, a live worksheet adapter, and the records are read out of its cells. A pivot *read from
 * a file* carries no `source` at all: the reader normalises it into `cacheFields`, `cacheDefinition` and
 * `cacheRecords`, which is the same information already resolved. `pivotParts` tested `source` alone and
 * returned `undefined` for the second, so **every XLSX→XLSB conversion dropped its pivot tables** — 35 of
 * them across the examples, and until recently without even a loss entry to say so.
 *
 * The parsed branch does not re-derive anything: `cacheRecords.records` is already one entry per source row
 * with shared-item fields resolved to indices, which is exactly `PivotCacheModel.records`. What it cannot
 * recover is the source *range*, because a parsed cache does not carry one — see `parsedRange`.
 */
function pivotCache(pivot: PivotTable, recordsRelationshipId: string): PivotCacheModel | undefined {
  const source = pivot.source;
  if (source !== undefined) {
    // `getSheetValues` is 1-indexed and sparse, and its first row is the header the cache fields were named
    // from — so the data starts at index 2.
    const rows = source
      .getSheetValues()
      .slice(2)
      .filter((row): row is unknown[] => Array.isArray(row));
    const dimensions = source.dimensions;
    return {
      sheetName: source.name,
      range: {
        rowFirst: Math.max(0, (dimensions.top ?? 1) - 1),
        rowLast: Math.max(0, (dimensions.bottom ?? 1) - 1),
        columnFirst: Math.max(0, (dimensions.left ?? 1) - 1),
        columnLast: Math.max(0, (dimensions.right ?? 1) - 1)
      },
      cacheFields: pivot.cacheFields,
      records: rows.map(row =>
        pivot.cacheFields.map((field, column) =>
          // `getSheetValues` is 1-indexed within a row as well, so column 0 is empty.
          cacheRecordValue(row[column + 1], field.sharedItems)
        )
      ),
      recordsRelationshipId
    };
  }

  const parsed = pivot.cacheRecords?.records;
  if (parsed === undefined) {
    return undefined;
  }
  // **The sheet and range the cache was really built from, which the reader does keep.**
  //
  // This used to substitute the pivot's *own* sheet and a range anchored at `A1`, on the stated grounds that
  // "`worksheetSource` is not among the fields the reader keeps". That was wrong: `cacheDefinition` carries `sourceSheet`
  // and `sourceRef` — `"Data"` and `"A1:C4"` for the oracle's `05-pivots` — and the substitution wrote the *output*
  // sheet's name instead. Excel's own save of the same workbook names `Data`; this named `OneRow`, the sheet the pivot
  // is displayed on.
  //
  // That is not cosmetic. `refreshOnLoad` is set on every cache this writer emits, so the first refresh reads the range
  // the cache names — and a cache pointing at its own output is either empty or circular. The cached values make it look
  // right until someone refreshes.
  const declaredSheet = (pivot.cacheDefinition as { sourceSheet?: string } | undefined)
    ?.sourceSheet;
  const declaredRef = (pivot.cacheDefinition as { sourceRef?: string } | undefined)?.sourceRef;
  return {
    // The pivot's own sheet remains the fallback for a cache that genuinely does not name one — an OLAP or external
    // source, where there is no worksheet range to point at.
    sheetName: declaredSheet ?? pivot.worksheetName ?? "",
    range: parsedRangeFrom(declaredRef) ?? parsedRange(pivot, parsed.length),
    cacheFields: pivot.cacheFields,
    records: parsed.map(row =>
      pivot.cacheFields.map((field, column) => parsedRecordValue(row[column], field.sharedItems))
    ),
    recordsRelationshipId
  };
}

/**
 * The source range of a parsed cache, reconstructed from its own shape.
 *
 * A header row plus one row per record, and one column per cache field — which is what the range described
 * before it was thrown away, since that is how the reader arrived at the field list and the records in the
 * first place. Anchored at A1 because the original offset is not recoverable and Excel recomputes the range
 * when it honours the `refreshOnLoad` this writer sets.
 */
/**
 * The declared source range, when the cache names one.
 *
 * `sourceRef` is an `A1:C4`-style reference the XLSX reader preserved verbatim, so this is a parse rather than a
 * reconstruction — and it is the difference between naming the range the data is in and naming a guess.
 */
function parsedRangeFrom(reference: string | undefined): PivotCacheModel["range"] | undefined {
  if (reference === undefined) {
    return undefined;
  }
  const match = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(reference);
  if (match === null) {
    return undefined;
  }
  const column = (letters: string): number =>
    [...letters.toUpperCase()].reduce(
      (total, letter) => total * 26 + (letter.charCodeAt(0) - 64),
      0
    ) - 1;
  return {
    rowFirst: Number(match[2]) - 1,
    rowLast: Number(match[4]) - 1,
    columnFirst: column(match[1]!),
    columnLast: column(match[3]!)
  };
}

function parsedRange(pivot: PivotTable, recordCount: number): PivotCacheModel["range"] {
  return {
    rowFirst: 0,
    rowLast: recordCount,
    columnFirst: 0,
    columnLast: Math.max(0, pivot.cacheFields.length - 1)
  };
}

/**
 * One parsed cache-record value in the form the cache encoder wants.
 *
 * The two forms line up almost exactly: a `"x"` entry is already the shared-item index the encoder writes,
 * and `"n"`/`"s"`/`"b"`/`"d"` are already the value. The cases worth naming are the two that are not:
 *
 * - `"m"` is a missing value and carries none, so it becomes the same empty string a live source's blank
 *   cell yields through {@link cacheRecordValue};
 * - `"e"` is an error, whose text is the only thing a `BrtPCDIString` can hold.
 *
 * A field *with* shared items whose record is not an `"x"` is re-resolved through `cacheRecordValue` rather
 * than trusted: mixing the two forms in one column is what a hand-edited file does, and writing a literal
 * where the field declares an index desynchronises the row.
 */
function parsedRecordValue(
  value: RecordValue | undefined,
  sharedItems: readonly SharedItemValue[] | null
): number | SharedItemValue {
  if (value === undefined || value.type === "m") {
    return sharedItems === null ? "" : cacheRecordValue(undefined, sharedItems);
  }
  if (value.type === "x") {
    return value.value;
  }
  if (sharedItems !== null) {
    return cacheRecordValue(value.value, sharedItems);
  }
  return value.type === "e" ? value.value : value.value;
}

/**
 * Cache-item indices sorted the way the field displays them.
 *
 * Numbers before strings and blanks last, which is the order Excel presents a mixed field in — and within each kind, the
 * natural comparison. Ties keep their cache order, so the result is stable.
 */
function displayOrder(items: readonly SharedItemValue[]): readonly number[] {
  // **A `Date` sorts chronologically, and it used to sort by its English month name.**
  //
  // It fell through to the string branch below, where `String(value)` is `Date.prototype.toString()` —
  // `"Mon Jan 15 2024 …"`. Comparing those puts January, *March*, then February, which is exactly the order this writer
  // produced for a pivot's date field. It is also locale-dependent, so the wrong order was a different wrong order
  // elsewhere.
  //
  // This is the third place in this codec where `Date` silently satisfied a string path: the cache definition's shared
  // items and the cache records both wrote `Date.prototype.toString()` into the file before this. A union containing
  // `Date` invites it, because the compiler is satisfied and `Date` has a `toString`.
  const rank = (value: SharedItemValue): number => {
    if (value === null || value === undefined) {
      return 2;
    }
    return typeof value === "number" || value instanceof Date ? 0 : 1;
  };
  // Both numbers and dates compare as numbers; a date's epoch milliseconds order the same way its serial does.
  const numericOf = (value: SharedItemValue): number | undefined =>
    typeof value === "number" ? value : value instanceof Date ? value.getTime() : undefined;
  return items
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const byKind = rank(left.value) - rank(right.value);
      if (byKind !== 0) {
        return byKind;
      }
      const leftNumber = numericOf(left.value);
      const rightNumber = numericOf(right.value);
      if (leftNumber !== undefined && rightNumber !== undefined) {
        const difference = leftNumber - rightNumber;
        return difference !== 0 ? difference : left.index - right.index;
      }
      const difference = String(left.value ?? "").localeCompare(String(right.value ?? ""));
      return difference !== 0 ? difference : left.index - right.index;
    })
    .map(entry => entry.index);
}
