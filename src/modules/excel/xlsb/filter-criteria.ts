/**
 * AutoFilter *criteria* — the records nested inside `BrtBeginAFilter`…`BrtEndAFilter`.
 *
 * The range alone is `encodeAutoFilter` in `filter.ts`; this is what makes an applied filter show the rows
 * it was applied to. The two are separate because the model keeps them separate: `autoFilter` is a range
 * string, while the criteria arrive as the **raw XML** the XLSX reader preserved on `autoFilterCriteria`.
 *
 * **The XML is the input on purpose, and this is the whole reason the feature became reachable.** There is
 * no public setter for a criterion — it only ever arrives from a read — and the XLSX writer replays that XML
 * back verbatim, which is what makes an XLSX round trip byte-exact. Introducing a structured model in
 * `core/` to feed this would have meant the XLSX writer re-serialising from that model instead, trading the
 * fidelity of the format that already works for the sake of the one that did not. Parsing here costs the
 * working path nothing.
 *
 * **The record order is not guessed.** MS-XLSB section 3.4 is a byte-level worked example of exactly this
 * sequence — `BrtBeginAFilter`, `BrtBeginFilterColumn`, `BrtBeginCustomFilters`, `BrtCustomFilter`, and the
 * matching ends — which is the authority that does not exist for pivot tables. Each layout comes from its
 * own record page.
 */

import { BinaryWriter, concatUint8Arrays } from "@utils/binary";
import { parseXml } from "@xml/dom";
import type { XmlElement } from "@xml/types";

/** What `filterCriteriaRecords` produces: the nested records, and the kinds it had to decline. */
export interface FilterCriteriaResult {
  /** `[name, payload]` pairs, in the order MS-XLSB 3.4 gives them. */
  readonly records: readonly (readonly [string, Uint8Array | undefined])[];
  /** Filter kinds present in the XML that this encoder does not express, by element name. */
  readonly unsupported: readonly string[];
}

/**
 * `grbitSgn` — the comparison operator of a `BrtCustomFilter`.
 *
 * Note that this is neither the XML's alphabetical order nor an obvious one: `equal` is 2 while `lessThan`
 * is 1, and `notEqual` is 5 while `greaterThanOrEqual` is 6. A table is the only honest way to write it.
 */
const CUSTOM_FILTER_OPERATOR: Readonly<Record<string, number>> = {
  lessThan: 0x01,
  equal: 0x02,
  lessThanOrEqual: 0x03,
  greaterThan: 0x04,
  notEqual: 0x05,
  greaterThanOrEqual: 0x06
};

/**
 * `cft` — the dynamic filter type, keyed by the XML's `type` attribute.
 *
 * **The enumeration has a hole in it.** `aboveAverage` and `belowAverage` are 1 and 2, and then the date
 * periods resume at **8** — 3 through 7 are not assigned. So this cannot be an array indexed by position in
 * the XML schema's list, which is how a "tomorrow" filter would come out as something with no meaning at
 * all. It is written out as a map for that reason.
 */
const DYNAMIC_FILTER_TYPE: Readonly<Record<string, number>> = {
  aboveAverage: 0x01,
  belowAverage: 0x02,
  tomorrow: 0x08,
  today: 0x09,
  yesterday: 0x0a,
  nextWeek: 0x0b,
  thisWeek: 0x0c,
  lastWeek: 0x0d,
  nextMonth: 0x0e,
  thisMonth: 0x0f,
  lastMonth: 0x10,
  nextQuarter: 0x11,
  thisQuarter: 0x12,
  lastQuarter: 0x13,
  nextYear: 0x14,
  thisYear: 0x15,
  lastYear: 0x16,
  yearToDate: 0x17,
  Q1: 0x18,
  Q2: 0x19,
  Q3: 0x1a,
  Q4: 0x1b,
  M1: 0x1c,
  M2: 0x1d,
  M3: 0x1e,
  M4: 0x1f,
  M5: 0x20,
  M6: 0x21,
  M7: 0x22,
  M8: 0x23,
  M9: 0x24,
  M10: 0x25,
  M11: 0x26,
  M12: 0x27
};

/**
 * `iIconSet` — a `KPISets`, keyed by the XML's `iconSet` attribute.
 *
 * The seventeen names are contiguous from 0, so the order *is* the value here — but it is still written as a
 * list rather than computed, because the model's own `IconSetType` union carries three names the record has
 * no value for (`3Stars`, `3Triangles`, `4RedToBlack` is present but `5Boxes` is not, and so on). An index
 * into the model's union would therefore drift from this enumeration silently.
 */
const ICON_SET: readonly string[] = [
  "3Arrows",
  "3ArrowsGray",
  "3Flags",
  "3TrafficLights1",
  "3TrafficLights2",
  "3Signs",
  "3Symbols",
  "3Symbols2",
  "4Arrows",
  "4ArrowsGray",
  "4RedToBlack",
  "4Rating",
  "4TrafficLights",
  "5Arrows",
  "5ArrowsGray",
  "5Rating",
  "5Quarters"
];

/** `dntChecked` — how much of the date is compared, keyed by the XML's `dateTimeGrouping`. */
const DATE_GROUPING: Readonly<Record<string, number>> = {
  year: 0,
  month: 1,
  day: 2,
  hour: 3,
  minute: 4,
  second: 5
};

/** `vts` — the data type of a `BrtCustomFilter`'s value. */
const VTS_NUMBER = 0x04;
const VTS_STRING = 0x06;

/** An `XLWideString`: a four-byte character count, then UTF-16. */
function wideString(value: string): Uint8Array {
  const characters = [...value];
  const writer = new BinaryWriter().writeUint32(characters.length);
  for (const character of characters.join("")) {
    writer.writeUint16(character.charCodeAt(0));
  }
  return writer.toUint8Array();
}

/**
 * Child elements of `element` with the given local name.
 *
 * By *local* name, because the preserved fragment may or may not carry the spreadsheetml prefix depending
 * on how the source file declared its namespaces — matching on `name` would work for one and silently find
 * nothing for the other.
 */
function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => child.type === "element" && localName(child) === name
  );
}

/** The local part of a possibly-prefixed element name. */
function localName(element: XmlElement): string {
  return element.local ?? element.name;
}

/** An attribute read as a boolean the OOXML way: absent is false, `"1"`/`"true"` are true. */
function flag(element: XmlElement, name: string): boolean {
  const value = element.attributes[name];
  return value === "1" || value === "true";
}

/**
 * The records for one `<filterColumn>`'s child, or `undefined` when the kind is not expressed here.
 */
function criterionRecords(
  child: XmlElement
): readonly (readonly [string, Uint8Array | undefined])[] | undefined {
  switch (localName(child)) {
    case "filters":
      return filtersRecords(child);
    case "customFilters":
      return customFiltersRecords(child);
    case "top10":
      return [["BrtTop10Filter", top10Payload(child)]];
    case "dynamicFilter": {
      const payload = dynamicFilterPayload(child);
      return payload === undefined ? undefined : [["BrtDynamicFilter", payload]];
    }
    case "colorFilter": {
      const payload = colorFilterPayload(child);
      return payload === undefined ? undefined : [["BrtColorFilter", payload]];
    }
    case "iconFilter": {
      const payload = iconFilterPayload(child);
      return payload === undefined ? undefined : [["BrtIconFilter", payload]];
    }
    default:
      return undefined;
  }
}

/** `<filters>` — a set of literal values, each its own `BrtFilter`. */
function filtersRecords(
  element: XmlElement
): readonly (readonly [string, Uint8Array | undefined])[] {
  const records: (readonly [string, Uint8Array | undefined])[] = [
    // `fBlank` then four unused bytes. `<filters blank="1">` is what shows rows whose cell is empty.
    [
      "BrtBeginFilters",
      new BinaryWriter()
        .writeUint32(flag(element, "blank") ? 1 : 0)
        .writeUint32(0)
        .toUint8Array()
    ]
  ];
  // `<filter>` and `<dateGroupItem>` are siblings inside `<filters>` and are walked in document order, not
  // in two passes: a date group item is a criterion in its own right, and reordering them would change
  // which values the filter shows.
  for (const child of element.children) {
    if (child.type !== "element") {
      continue;
    }
    if (localName(child) === "filter") {
      const value = child.attributes.val;
      // A `BrtFilter` string must be at least one character, so an empty `val` is not writable — and it is
      // also not meaningful: emptiness is `<filters blank="1">`, which is already handled above.
      if (value !== undefined && value.length > 0) {
        records.push(["BrtFilter", wideString(value)]);
      }
      continue;
    }
    if (localName(child) === "dateGroupItem") {
      records.push(["BrtAFilterDateGroupItem", dateGroupItemPayload(child)]);
    }
  }
  records.push(["BrtEndFilters", undefined]);
  return records;
}

/** `<customFilters>` — one or two comparisons joined by AND or OR. */
function customFiltersRecords(
  element: XmlElement
): readonly (readonly [string, Uint8Array | undefined])[] {
  // **`fAnd` is inverted**: MS-XLSB gives 0x00000000 for AND and 0x00000001 for OR, while the XML spells the
  // same thing as `and="1"`. Writing the attribute straight through swaps AND for OR on every two-criterion
  // filter — a filter that quietly shows the wrong rows rather than a file that fails to open.
  const records: (readonly [string, Uint8Array | undefined])[] = [
    [
      "BrtBeginCustomFilters",
      new BinaryWriter().writeUint32(flag(element, "and") ? 0 : 1).toUint8Array()
    ]
  ];
  for (const filter of childrenNamed(element, "customFilter")) {
    records.push(["BrtCustomFilter", customFilterPayload(filter)]);
  }
  records.push(["BrtEndCustomFilters", undefined]);
  return records;
}

/** One `BrtCustomFilter`: type, operator, an eight-byte union, and a string when the type says so. */
function customFilterPayload(element: XmlElement): Uint8Array {
  const value = element.attributes.val ?? "";
  // The XML does not say which type it is; the value does. A `val` that parses as a number is a numeric
  // comparison, and anything else is a string one — which is also how the wildcards `?` and `*` survive,
  // since they only mean anything in the string form.
  const numeric = value !== "" && Number.isFinite(Number(value));
  // `equal` is the default when the attribute is absent, matching the XML schema.
  const operator = CUSTOM_FILTER_OPERATOR[element.attributes.operator ?? "equal"] ?? 0x02;
  const writer = new BinaryWriter()
    .writeUint8(numeric ? VTS_NUMBER : VTS_STRING)
    .writeUint8(operator);
  if (numeric) {
    writer.writeFloat64(Number(value));
    return writer.toUint8Array();
  }
  // The union is eight bytes whatever the type: for a string it is "unused" rather than absent, so the
  // string that follows would start eight bytes early without it.
  writer.writeFloat64(0);
  return concatUint8Arrays([writer.toUint8Array(), wideString(value)]);
}

/** `BrtTop10Filter`: a flag byte, then the count and the computed threshold. */
function top10Payload(element: XmlElement): Uint8Array {
  const top = flag(element, "top") || element.attributes.top === undefined;
  const percent = flag(element, "percent");
  const filterValue = element.attributes.filterVal;
  // `fApplied` says `xNumFilter` is a real value from the range. Claiming it while writing 0 would tell
  // Excel to compare against zero rather than to recalculate.
  const applied = filterValue !== undefined && Number.isFinite(Number(filterValue));
  const flags = (top ? 0x01 : 0) | (percent ? 0x02 : 0) | (applied ? 0x04 : 0);
  return new BinaryWriter()
    .writeUint8(flags)
    .writeFloat64(Number(element.attributes.val ?? 0))
    .writeFloat64(applied ? Number(filterValue) : 0)
    .toUint8Array();
}

/**
 * `BrtDynamicFilter` — MS-XLSB 2.4.354. Twenty-one bytes: the type, a flag byte, and two `Xnum`.
 *
 * Three constraints the specification states and this respects, each of which produces a record Excel is
 * entitled to reject rather than a wrong-looking filter:
 *
 * - `fApplied` MUST be 0 when `cft` is 0 or at least 0x18 — the "regardless of year" periods have no
 *   computed range to have been calculated.
 * - `xNumValue` MUST be 0 unless `cft` is between 1 and 0x17.
 * - `xNumValueMax` MUST be 0 unless `cft` is between 8 and 0x17.
 *
 * The XML carries no computed values at all — Excel recalculates a dynamic filter on open, which is the
 * point of calling it dynamic — so both numbers are 0 here and `fApplied` is 0 with them. Claiming
 * `fApplied` while writing zeroes would assert that zero *is* the computed average.
 *
 * @returns `undefined` for a type the enumeration has no value for, so the caller reports it rather than
 *   writing `CFTNIL`, which is a record that specifies no filter.
 */
function dynamicFilterPayload(element: XmlElement): Uint8Array | undefined {
  const cft = DYNAMIC_FILTER_TYPE[element.attributes.type ?? ""];
  if (cft === undefined) {
    return undefined;
  }
  return new BinaryWriter()
    .writeUint32(cft)
    .writeUint8(0)
    .writeFloat64(0)
    .writeFloat64(0)
    .toUint8Array();
}

/**
 * `BrtColorFilter` — MS-XLSB 2.4.347. Eight bytes: a differential format id and which colour to match.
 *
 * `dxfid` MUST NOT be 0xFFFFFFFF, which is the "no format" sentinel — so a `<colorFilter>` with no `dxfId`
 * has nothing to filter by and is declined rather than written with the sentinel.
 *
 * `fCellColor` is **absent-means-true** in the XML: `<colorFilter dxfId="0"/>` filters by fill colour, and
 * only an explicit `cellColor="0"` means the font colour. Reading it as a plain flag inverts every
 * fill-colour filter into a font-colour one.
 */
function colorFilterPayload(element: XmlElement): Uint8Array | undefined {
  const dxfId = element.attributes.dxfId;
  if (dxfId === undefined || !Number.isInteger(Number(dxfId)) || Number(dxfId) < 0) {
    return undefined;
  }
  const cellColour = element.attributes.cellColor === undefined || flag(element, "cellColor");
  return new BinaryWriter()
    .writeUint32(Number(dxfId))
    .writeUint32(cellColour ? 1 : 0)
    .toUint8Array();
}

/**
 * `BrtIconFilter` — MS-XLSB 2.4.362. Eight bytes: the icon set and the icon within it.
 *
 * `iIcon` is **signed** — it is -1 exactly when the set is `KPINIL`, which is a record that specifies no
 * filter. So an unrecognised icon set is declined rather than written as `KPINIL`, and `iIcon` is written
 * through the two's-complement conversion because the writer has no signed 32-bit method.
 */
function iconFilterPayload(element: XmlElement): Uint8Array | undefined {
  const iconSet = ICON_SET.indexOf(element.attributes.iconSet ?? "");
  if (iconSet === -1) {
    return undefined;
  }
  const icon = Number(element.attributes.iconId ?? 0);
  if (!Number.isInteger(icon) || icon < 0) {
    return undefined;
  }
  return new BinaryWriter().writeUint32(iconSet).writeUint32(icon).toUint8Array();
}

/**
 * `BrtAFilterDateGroupItem` — MS-XLSB 2.4.4. Twenty-four bytes.
 *
 * ```
 * yr          u16
 * mon         u16
 * dom         u32   ← note the width: the day is four bytes while the hour is two
 * hour        u16
 * min         u16
 * sec         u16
 * unused1     u16
 * unused2     u32
 * dntChecked  u32   how much of the date is compared
 * ```
 *
 * The widths are not uniform and not in an obvious order — `dom` is twice the width of `hour` — which is
 * the kind of thing that shifts every field after it by two bytes if assumed rather than read.
 *
 * `dntChecked` says how much of the record is significant, and the specification's bounds are conditional on
 * it: a `month` grouping requires a valid `mon` but says nothing about `dom`. The values are clamped to
 * their stated ranges rather than trusted, because an out-of-range field makes the record invalid whether or
 * not the grouping looks at it.
 */
function dateGroupItemPayload(element: XmlElement): Uint8Array {
  const grouping = DATE_GROUPING[element.attributes.dateTimeGrouping ?? "year"] ?? 0;
  const bounded = (name: string, low: number, high: number, fallback: number): number => {
    const value = Number(element.attributes[name] ?? fallback);
    return Number.isFinite(value) ? Math.max(low, Math.min(high, Math.trunc(value))) : fallback;
  };
  return new BinaryWriter()
    .writeUint16(bounded("year", 1000, 9999, 1000))
    .writeUint16(bounded("month", 1, 12, 1))
    .writeUint32(bounded("day", 1, 31, 1))
    .writeUint16(bounded("hour", 0, 23, 0))
    .writeUint16(bounded("minute", 0, 59, 0))
    .writeUint16(bounded("second", 0, 59, 0))
    .writeUint16(0)
    .writeUint32(0)
    .writeUint32(grouping)
    .toUint8Array();
}

/**
 * The records nested inside `BrtBeginAFilter` for the criteria the XLSX reader preserved.
 *
 * @param xml - The `autoFilterCriteria.xml` fragment: a run of `<filterColumn>` elements with no wrapper.
 */
export function filterCriteriaRecords(xml: string): FilterCriteriaResult {
  const records: (readonly [string, Uint8Array | undefined])[] = [];
  const unsupported = new Set<string>();
  // The fragment has no single root, so it gets one here rather than using the parser's `fragment` mode:
  // that mode returns the *first* element as the root and silently drops the rest, so a three-column filter
  // would come out as a one-column filter with nothing to indicate it.
  //
  // `xmlns: true` is what populates `local`. Without it the parser leaves that field undefined and the name
  // keeps whatever prefix the source file used, so a prefixed fragment matches nothing and yields an empty
  // — but perfectly well-formed — filter.
  let root: XmlElement;
  try {
    root = parseXml(`<a>${xml}</a>`, { xmlns: true }).root;
  } catch {
    return { records: [], unsupported: ["filterColumn"] };
  }
  for (const column of childrenNamed(root, "filterColumn")) {
    const nested: (readonly [string, Uint8Array | undefined])[] = [];
    for (const child of column.children) {
      if (child.type !== "element") {
        continue;
      }
      const criterion = criterionRecords(child);
      if (criterion === undefined) {
        unsupported.add(localName(child));
      } else {
        nested.push(...criterion);
      }
    }
    // A `BrtBeginFilterColumn` with nothing inside is a column with dropdown state and no criterion. That
    // is a legal record but writing one for a column whose only child was declined would claim the filter
    // came across, so the column is skipped and the kind is reported instead.
    if (nested.length === 0) {
      continue;
    }
    records.push([
      "BrtBeginFilterColumn",
      new BinaryWriter()
        .writeUint32(Number(column.attributes.colId ?? 0))
        // `fHideArrow` at bit 0 and `fNoBtn` at bit 1. The two attributes have *opposite* defaults, which is
        // the trap: `hiddenButton` is absent-means-false, but `showButton` is absent-means-**true**, so
        // reading it as a plain flag sets `fNoBtn` on every column and hides every dropdown button in the
        // sheet — a filter that is in the file and cannot be reached from the interface.
        .writeUint16(
          (flag(column, "hiddenButton") ? 0x01 : 0) |
            (column.attributes.showButton !== undefined && !flag(column, "showButton") ? 0x02 : 0)
        )
        .toUint8Array()
    ]);
    records.push(...nested);
    records.push(["BrtEndFilterColumn", undefined]);
  }
  return { records, unsupported: [...unsupported] };
}

// =============================================================================
// Reading
// =============================================================================

/**
 * Rebuild the `<filterColumn>` XML from the records inside a `BrtBeginAFilter`.
 *
 * **XML is the output because XML is what the model holds.** `autoFilterCriteria.xml` is the field the XLSX
 * writer replays verbatim, so producing anything else would need a second representation and a second writer
 * to consume it. Reading back into the same shape means a workbook read from XLSB and written to XLSX carries
 * its criteria through the path that already works.
 *
 * The inverse tables are derived from the write-side ones rather than listed again. That matters most for
 * `fAnd`, which is inverted: reading it as written would turn every AND back into an OR, and a test comparing
 * this reader against that writer would not notice, because both would be wrong the same way.
 */
const DYNAMIC_TYPE_BY_VALUE = new Map(
  Object.entries(DYNAMIC_FILTER_TYPE).map(([name, value]) => [value, name])
);
const DATE_GROUPING_BY_VALUE = new Map(
  Object.entries(DATE_GROUPING).map(([name, value]) => [value, name])
);
const CUSTOM_OPERATOR_BY_VALUE = new Map(
  Object.entries(CUSTOM_FILTER_OPERATOR).map(([name, value]) => [value, name])
);

/**
 * The records `readFilterCriteria` understands.
 *
 * Exported so the sheet reader can collect *these* rather than everything between `BrtBeginAFilter` and
 * `BrtEndAFilter`. Blanket collection was the first shape and it had a failure mode worth naming: a file
 * missing its `BrtEndAFilter` — which this writer cannot produce but a reader must survive — swallowed every
 * record after the filter. Conditional formatting, validations and page setup all vanished silently, and the
 * cells escaped only because they happen to come *earlier* in the part.
 *
 * Naming the set means an unterminated collection costs the criteria and nothing else.
 */
export const FILTER_CRITERIA_RECORDS: ReadonlySet<string> = new Set([
  "BrtBeginFilterColumn",
  "BrtEndFilterColumn",
  "BrtBeginFilters",
  "BrtEndFilters",
  "BrtFilter",
  "BrtBeginCustomFilters",
  "BrtEndCustomFilters",
  "BrtCustomFilter",
  "BrtTop10Filter",
  "BrtDynamicFilter",
  "BrtColorFilter",
  "BrtIconFilter",
  "BrtAFilterDateGroupItem"
]);

/** An XML attribute value with the five characters that must be escaped. */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One record's name and payload, as the part iterator yields them. */
export interface FilterCriteriaRecord {
  readonly name: string;
  readonly payload?: Uint8Array;
}

/**
 * The `<filterColumn>` fragment for a run of records, or `undefined` when there are none.
 *
 * Takes the records between `BrtBeginAFilter` and `BrtEndAFilter`. Elements are closed on the matching `End`
 * record rather than tracked by depth, because the nesting is shallow and fixed — a column holds exactly one
 * criterion collection — and a depth counter would silently accept a stream this writer cannot produce.
 */
export function readFilterCriteria(records: readonly FilterCriteriaRecord[]): string | undefined {
  const parts: string[] = [];
  for (const { name, payload } of records) {
    switch (name) {
      case "BrtBeginFilterColumn": {
        if (payload === undefined || payload.length < 6) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const flags = view.getUint16(4, true);
        parts.push(
          `<filterColumn colId="${view.getUint32(0, true)}"` +
            // Only written when it differs from the default, so a round trip does not accumulate attributes
            // Excel itself would leave out.
            ((flags & 0x01) !== 0 ? ' hiddenButton="1"' : "") +
            ((flags & 0x02) !== 0 ? ' showButton="0"' : "") +
            ">"
        );
        break;
      }
      case "BrtEndFilterColumn":
        parts.push("</filterColumn>");
        break;
      case "BrtBeginFilters": {
        const blank =
          payload !== undefined &&
          payload.length >= 4 &&
          new DataView(payload.buffer, payload.byteOffset).getUint32(0, true) !== 0;
        parts.push(`<filters${blank ? ' blank="1"' : ""}>`);
        break;
      }
      case "BrtEndFilters":
        parts.push("</filters>");
        break;
      case "BrtFilter": {
        if (payload === undefined || payload.length < 4) {
          break;
        }
        parts.push(`<filter val="${attribute(wideStringAt(payload, 0))}"/>`);
        break;
      }
      case "BrtBeginCustomFilters": {
        // `fAnd` is inverted: 0 is AND and 1 is OR, while the XML spells AND as `and="1"`.
        const isAnd =
          payload !== undefined &&
          payload.length >= 4 &&
          new DataView(payload.buffer, payload.byteOffset).getUint32(0, true) === 0;
        parts.push(`<customFilters${isAnd ? ' and="1"' : ""}>`);
        break;
      }
      case "BrtEndCustomFilters":
        parts.push("</customFilters>");
        break;
      case "BrtCustomFilter": {
        if (payload === undefined || payload.length < 10) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const operator = CUSTOM_OPERATOR_BY_VALUE.get(view.getUint8(1));
        const value =
          view.getUint8(0) === VTS_STRING
            ? attribute(wideStringAt(payload, 10))
            : String(view.getFloat64(2, true));
        parts.push(
          `<customFilter${operator === undefined ? "" : ` operator="${operator}"`} val="${value}"/>`
        );
        break;
      }
      case "BrtTop10Filter": {
        if (payload === undefined || payload.length < 17) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const flags = view.getUint8(0);
        parts.push(
          `<top10 top="${(flags & 0x01) !== 0 ? 1 : 0}" percent="${(flags & 0x02) !== 0 ? 1 : 0}"` +
            ` val="${view.getFloat64(1, true)}"` +
            // `filterVal` only when `fApplied` says the threshold is a real computed value.
            ((flags & 0x04) !== 0 ? ` filterVal="${view.getFloat64(9, true)}"` : "") +
            "/>"
        );
        break;
      }
      case "BrtDynamicFilter": {
        if (payload === undefined || payload.length < 4) {
          break;
        }
        const type = DYNAMIC_TYPE_BY_VALUE.get(
          new DataView(payload.buffer, payload.byteOffset).getUint32(0, true)
        );
        if (type !== undefined) {
          parts.push(`<dynamicFilter type="${type}"/>`);
        }
        break;
      }
      case "BrtColorFilter": {
        if (payload === undefined || payload.length < 8) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset);
        // `cellColor` is absent-means-true, so only the false case is written back.
        parts.push(
          `<colorFilter dxfId="${view.getUint32(0, true)}"` +
            (view.getUint32(4, true) === 0 ? ' cellColor="0"' : "") +
            "/>"
        );
        break;
      }
      case "BrtIconFilter": {
        if (payload === undefined || payload.length < 8) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset);
        const set = ICON_SET[view.getUint32(0, true)];
        if (set !== undefined) {
          parts.push(`<iconFilter iconSet="${set}" iconId="${view.getInt32(4, true)}"/>`);
        }
        break;
      }
      case "BrtAFilterDateGroupItem": {
        if (payload === undefined || payload.length < 24) {
          break;
        }
        const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const grouping = DATE_GROUPING_BY_VALUE.get(view.getUint32(20, true)) ?? "year";
        // Only the fields the grouping actually compares, because the specification bounds the rest
        // conditionally and writing them back would assert values it does not constrain.
        const depth = view.getUint32(20, true);
        const fields = [
          `year="${view.getUint16(0, true)}"`,
          ...(depth >= 1 ? [`month="${view.getUint16(2, true)}"`] : []),
          ...(depth >= 2 ? [`day="${view.getUint32(4, true)}"`] : []),
          ...(depth >= 3 ? [`hour="${view.getUint16(8, true)}"`] : []),
          ...(depth >= 4 ? [`minute="${view.getUint16(10, true)}"`] : []),
          ...(depth >= 5 ? [`second="${view.getUint16(12, true)}"`] : [])
        ];
        parts.push(`<dateGroupItem ${fields.join(" ")} dateTimeGrouping="${grouping}"/>`);
        break;
      }
      default:
        break;
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/** An `XLWideString` at an offset: a four-byte character count, then UTF-16. */
function wideStringAt(payload: Uint8Array, offset: number): string {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const characters = view.getUint32(offset, true);
  let text = "";
  for (let index = 0; index < characters; index += 1) {
    text += String.fromCharCode(view.getUint16(offset + 4 + index * 2, true));
  }
  return text;
}
