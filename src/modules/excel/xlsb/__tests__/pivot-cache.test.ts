/**
 * The two PivotCache parts and the workbook records that bind a cache to its definition.
 *
 * Sizes are asserted against the field tables in `[MS-XLSB]` rather than against what the encoder happens to
 * produce, and the nesting against the worked example in section 3.8 — which is the ordering authority an
 * earlier version of this module claimed did not exist.
 *
 * Nothing here is wired into the package writer yet: a pivot table needs all four parts at once, because the
 * specification requires one cache definition part per `BrtBeginPivotCacheID` record in the workbook.
 */

import type { CacheField } from "@excel/core/pivot-table-types";
import {
  pivotCacheDefinitionRecords,
  pivotCacheIdRecords,
  pivotCacheRecordsRecords,
  type PivotCacheModel,
  type PivotRecord
} from "@excel/xlsb/pivot-cache";
import { RECORD_BY_NAME } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A two-field cache: one with shared items, one without. */
function sampleCache(overrides: Partial<PivotCacheModel> = {}): PivotCacheModel {
  return {
    sheetName: "Data",
    range: { rowFirst: 0, rowLast: 3, columnFirst: 0, columnLast: 1 },
    cacheFields: [
      { name: "Region", sharedItems: ["APAC", "EMEA"] },
      { name: "Units", sharedItems: null }
    ],
    records: [
      [0, 10],
      [1, 20],
      [0, 30]
    ],
    recordsRelationshipId: "rId1",
    ...overrides
  };
}

/** `[name, payloadLength]` pairs, for asserting shape and nesting together. */
function shapeOf(records: readonly PivotRecord[]): [string, number][] {
  return records.map(([name, payload]) => [name, payload?.length ?? 0]);
}

/** The payload of the first record with the given name. */
function payloadOf(records: readonly PivotRecord[], name: string): DataView {
  const found = records.find(([recordName]) => recordName === name);
  if (found?.[1] === undefined) {
    throw new Error(`no ${name} record with a payload`);
  }
  return new DataView(found[1].buffer, found[1].byteOffset, found[1].length);
}

describe("every record it emits is one the table knows", () => {
  it("names only records that resolve", () => {
    // A misspelled name reaches the archive as a record this library cannot read back, and the writer would
    // not notice. The 868-entry name table is the check.
    const all = [
      ...pivotCacheIdRecords([{ cacheId: 10, relationshipId: "rId3" }]),
      ...pivotCacheDefinitionRecords(sampleCache()),
      ...pivotCacheRecordsRecords(sampleCache())
    ];
    const unknown = [...new Set(all.map(([name]) => name))].filter(
      name => !RECORD_BY_NAME.has(name)
    );
    expect(unknown).toEqual([]);
  });
});

describe("BrtBeginPivotCacheID — the workbook's half of the binding", () => {
  it("is the cache id and a relationship id", () => {
    const records = pivotCacheIdRecords([{ cacheId: 10, relationshipId: "rId3" }]);
    expect(shapeOf(records)).toEqual([
      // Empty, not a count. Section 2.4.170 gives this record no fields and section 3.8.1 declares its size
      // as `0000`; this expected 4, and Excel would not open the workbook. Its neighbours are no guide —
      // `BrtBeginSXVDs` is `0004` with a count — so the declared size is checked per record.
      ["BrtBeginPivotCacheIDs", 0],
      // `idSx` plus an `XLWideString`: 4 for the id, 4 for the count and 8 for "rId3".
      ["BrtBeginPivotCacheID", 16],
      ["BrtEndPivotCacheID", 0],
      ["BrtEndPivotCacheIDs", 0]
    ]);
    expect(payloadOf(records, "BrtBeginPivotCacheID").getUint32(0, true)).toBe(10);
  });

  it("emits nothing at all for a workbook with no caches", () => {
    // An empty `BrtBeginPivotCacheIDs` collection is a claim that there are caches to find.
    expect(pivotCacheIdRecords([])).toEqual([]);
  });
});

describe("the cache definition part", () => {
  it("nests in the order MS-XLSB 3.8 gives", () => {
    expect(shapeOf(pivotCacheDefinitionRecords(sampleCache()))).toEqual([
      // 21 fixed, 12 for the records relationship id, 4 for the unused tail.
      ["BrtBeginPivotCacheDef", 37],
      ["BrtBeginPCDSource", 8],
      // Three flag bytes, 12 for "Data", 16 for the RfX.
      ["BrtBeginPCDSRange", 31],
      ["BrtEndPCDSRange", 0],
      ["BrtEndPCDSource", 0],
      ["BrtBeginPCDFields", 4],
      // 20 fixed plus 16 for "Region".
      ["BrtBeginPCDField", 36],
      ["BrtBeginPCDFAtbl", 6],
      ["BrtPCDIString", 12],
      ["BrtPCDIString", 12],
      ["BrtEndPCDFAtbl", 0],
      ["BrtEndPCDField", 0],
      // 20 fixed plus 14 for "Units". The item collection is still present with `sharedItems: null` — it
      // carries no items, but its flags are the only thing saying what the inline values in each
      // `BrtPCRRecord` are, and 22 bytes because a numeric field's bounds follow the fixed six.
      ["BrtBeginPCDField", 34],
      ["BrtBeginPCDFAtbl", 22],
      ["BrtEndPCDFAtbl", 0],
      ["BrtEndPCDField", 0],
      ["BrtEndPCDFields", 0],
      ["BrtEndPivotCacheDef", 0]
    ]);
  });

  it("writes the unused tail that is present precisely when the user name is absent", () => {
    // The four bytes exist *if and only if* `fLoadRefreshedWho` is 0, so omitting both leaves the record
    // four bytes short and misaligns every field after it. It reads as a presence flag and behaves as
    // padding, which is why the length is asserted rather than the flag.
    const payload = payloadOf(pivotCacheDefinitionRecords(sampleCache()), "BrtBeginPivotCacheDef");
    // 21 fixed + 12 relationship id + 4 unused.
    expect(payload.byteLength).toBe(37);
    // `fLoadRefreshedWho` is bit 0 of the second flag byte, at offset 16.
    expect(payload.getUint8(16) & 0x01).toBe(0);
    expect(payload.getUint32(33, true)).toBe(0);
  });

  it("sets fLoadRelIDRecords with fSaveData, and neither without a records part", () => {
    // The specification ties them: `fLoadRelIDRecords` MUST be 1 when `fSaveData` is 1.
    const withRecords = payloadOf(
      pivotCacheDefinitionRecords(sampleCache()),
      "BrtBeginPivotCacheDef"
    );
    expect(withRecords.getUint8(3) & 0x01).toBe(0x01);
    expect(withRecords.getUint8(16) & 0x02).toBe(0x02);
    const without = payloadOf(
      pivotCacheDefinitionRecords(sampleCache({ recordsRelationshipId: undefined })),
      "BrtBeginPivotCacheDef"
    );
    expect(without.getUint8(3) & 0x01).toBe(0);
    expect(without.getUint8(16) & 0x02).toBe(0);
    // 21 fixed + 4 unused, with no relationship id between them.
    expect(without.byteLength).toBe(25);
  });

  it("writes a zero refresh date rather than a clock reading", () => {
    // Two writes of the same workbook have to produce the same bytes; the round-trip tests compare them.
    expect(
      payloadOf(pivotCacheDefinitionRecords(sampleCache()), "BrtBeginPivotCacheDef").getFloat64(
        8,
        true
      )
    ).toBe(0);
  });

  it("puts the flags before the sheet name and the range last", () => {
    // The order is flags → name → range, from the worked example. Reversing the last two is the kind of
    // thing that produces a plausible record with the range read out of the middle of a name.
    const payload = payloadOf(pivotCacheDefinitionRecords(sampleCache()), "BrtBeginPCDSRange");
    // `fLoadSheet` at bit 1 of the third flag byte: the source is scoped to one sheet.
    expect(payload.getUint8(2) & 0x02).toBe(0x02);
    // The name's character count, then the RfX bounds after it.
    expect(payload.getUint32(3, true)).toBe(4);
    expect(payload.getUint32(15, true)).toBe(0);
    expect(payload.getUint32(19, true)).toBe(3);
    expect(payload.getUint32(23, true)).toBe(0);
    expect(payload.getUint32(27, true)).toBe(1);
  });

  it("marks every field it writes as a source field", () => {
    // `fSrcField` is required on the first field, and every field without it must come last. A field derived
    // from a source column is a source field, so all of them carry it.
    expect(
      payloadOf(pivotCacheDefinitionRecords(sampleCache()), "BrtBeginPCDField").getUint8(0) & 0x04
    ).toBe(0x04);
  });

  it("derives the shared-item flags from the items, not from the model's XLSX attributes", () => {
    // `BrtPCRRecord` has no per-item tag: a reader decides whether an inline value is an Xnum, a date or a
    // string from these flags. The model's `containsNumber` and friends are preserved *XLSX* attribute
    // strings and may be absent, so trusting them would mistype the record's own values.
    const flagsFor = (items: CacheField["sharedItems"]): number =>
      payloadOf(
        pivotCacheDefinitionRecords(
          sampleCache({ cacheFields: [{ name: "F", sharedItems: items }], records: [[0]] })
        ),
        "BrtBeginPCDFAtbl"
      ).getUint16(0, true);
    // **`ALWAYS` is bit 10, which Excel sets on every field.** All nine `BrtBeginPCDFAtbl` records across the oracle's
    // reference workbooks carry it whatever the field holds — `0x040b`, `0x05c2`, `0x0504` — so it describes nothing
    // about the content and is reproduced rather than left clear. Named here so each expectation below still reads as
    // "these flags, from these items".
    const ALWAYS = 0x0400;
    /**
     * `fNumMinMaxValid`, set for a field whose values are all comparable — all numbers, or all dates.
     *
     * These expectations omitted it, and passed because the two functions that wrote this record disagreed: the one for
     * enumerated items bounded only *dates*, the one for inline values bounded only *numbers*. Excel bounds both, which
     * its own bytes for `05-pivots` say plainly — `0x05c2` over 22 bytes for the numeric field, `0x0504` over 22 for the
     * date one. Merging the two writers into `fieldTypeFlags` made the omission visible.
     */
    const BOUNDED = 0x0100;
    // Text: fTextEtcField | fNonDates | fHasTextItem. No bounds — a range over text describes nothing.
    expect(flagsFor(["a", "b"])).toBe(ALWAYS | 0x0001 | 0x0002 | 0x0008);
    // Integers: fNonDates | fNumField | fIntField, and bounded.
    expect(flagsFor([1, 2])).toBe(ALWAYS | 0x0002 | 0x0040 | 0x0080 | BOUNDED);
    // A non-integer number clears fIntField and is still bounded.
    expect(flagsFor([1.5])).toBe(ALWAYS | 0x0002 | 0x0040 | BOUNDED);
    // Mixed text and numbers sets fMixedTypesIgnoringBlanks.
    expect(flagsFor(["a", 1])).toBe(ALWAYS | 0x0001 | 0x0002 | 0x0008 | 0x0020 | 0x0040 | 0x0080);
    // A blank sets both fTextEtcField and fHasBlankItem, and counts as a non-date.
    expect(flagsFor([null])).toBe(ALWAYS | 0x0001 | 0x0002 | 0x0010);
    // Even when the model claims otherwise. `containsNumber: "1"` describes the XLSX form of a text field.
    expect(
      payloadOf(
        pivotCacheDefinitionRecords(
          sampleCache({
            cacheFields: [{ name: "F", sharedItems: ["a"], containsNumber: "1" }],
            records: [[0]]
          })
        ),
        "BrtBeginPCDFAtbl"
      ).getUint16(0, true) & 0x0040
    ).toBe(0);
  });

  it("still describes the type of a field whose values are inline", () => {
    // `sharedItems: null` says the values live inline in each cache record. This test asserted the opposite
    // of what it now does — that the collection was *omitted* — and Excel would not open the workbook at
    // all. A `BrtPCRRecord` carries no per-item tag, so these flags are the only thing that says whether a
    // field contributes a four-byte index or an eight-byte `Xnum`; without them the cache record stream
    // cannot be parsed at any position, which is why the failure was total rather than a repaired record.
    const shape = shapeOf(
      pivotCacheDefinitionRecords(
        sampleCache({ cacheFields: [{ name: "F", sharedItems: null }], records: [[1], [4]] })
      )
    ).filter(([name]) => name.includes("PCDFAtbl"));
    // Six fixed bytes plus the two `Xnum` bounds, which follow because `fNumMinMaxValid` is set.
    expect(shape).toEqual([
      ["BrtBeginPCDFAtbl", 22],
      ["BrtEndPCDFAtbl", 0]
    ]);
  });

  it("derives the inline field's flags and bounds from the values themselves", () => {
    const payload = pivotCacheDefinitionRecords(
      sampleCache({ cacheFields: [{ name: "F", sharedItems: null }], records: [[3], [7]] })
    ).find(([name]) => name === "BrtBeginPCDFAtbl")?.[1] as Uint8Array;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const flags = view.getUint16(0, true);
    expect(flags & 0x0040).not.toBe(0); // fNumField
    expect(flags & 0x0080).not.toBe(0); // fIntField — both values are integers
    expect(flags & 0x0100).not.toBe(0); // fNumMinMaxValid
    expect(flags & 0x0008).toBe(0); // fHasTextItem
    expect(view.getUint32(2, true)).toBe(0); // citems: there are none
    expect(view.getFloat64(6, true)).toBe(3);
    expect(view.getFloat64(14, true)).toBe(7);
  });

  it("asks Excel to refresh on load, as the XLSX writer does for the same reason", () => {
    // The layout records are minimal — one grand-total row item — so Excel has to expand them itself. The
    // XLSX writer sets `refreshOnLoad="1"` unconditionally and says it is "important for our implementation
    // to work"; this writer emitted the same minimal layout while claiming the cache was current.
    const payload = pivotCacheDefinitionRecords(sampleCache()).find(
      ([name]) => name === "BrtBeginPivotCacheDef"
    )?.[1] as Uint8Array;
    expect(payload[3]! & 0x04).not.toBe(0); // fRefreshOnLoad
  });

  it("chooses the item record that matches the value's type", () => {
    const namesFor = (items: CacheField["sharedItems"]): string[] =>
      pivotCacheDefinitionRecords(
        sampleCache({ cacheFields: [{ name: "F", sharedItems: items }], records: [[0]] })
      )
        .map(([name]) => name)
        .filter(name => name.startsWith("BrtPCDI"));
    expect(namesFor(["a"])).toEqual(["BrtPCDIString"]);
    expect(namesFor([1])).toEqual(["BrtPCDINumber"]);
    expect(namesFor([true])).toEqual(["BrtPCDIBoolean"]);
    expect(namesFor([null])).toEqual(["BrtPCDIMissing"]);
    expect(namesFor(["a", 1, null])).toEqual(["BrtPCDIString", "BrtPCDINumber", "BrtPCDIMissing"]);
  });

  it("agrees with itself about how many fields and items there are", () => {
    // `cfields` and `citems` are counts a reader trusts; a disagreement makes it read past the collection.
    const records = pivotCacheDefinitionRecords(sampleCache());
    expect(payloadOf(records, "BrtBeginPCDFields").getUint32(0, true)).toBe(
      records.filter(([name]) => name === "BrtBeginPCDField").length
    );
    expect(payloadOf(records, "BrtBeginPCDFAtbl").getUint32(2, true)).toBe(
      records.filter(([name]) => name.startsWith("BrtPCDI")).length
    );
  });
});

describe("the cache records part", () => {
  it("is one record per source row, counted in the header", () => {
    const records = pivotCacheRecordsRecords(sampleCache());
    expect(shapeOf(records)).toEqual([
      ["BrtBeginPivotCacheRecords", 4],
      // Four bytes of index for the shared-item field, eight of Xnum for the one without.
      ["BrtPCRRecord", 12],
      ["BrtPCRRecord", 12],
      ["BrtPCRRecord", 12],
      ["BrtEndPivotCacheRecords", 0]
    ]);
    expect(payloadOf(records, "BrtBeginPivotCacheRecords").getUint32(0, true)).toBe(3);
  });

  it("writes an inline date as eight structured bytes", () => {
    // **Excel's encoding, and previously 152 bytes of English.** A field with no shared items stores its values
    // inline in each `BrtPCRRecord`, and a `Date` reaching that path was passed through `String()` — so the
    // record carried `"Mon Jan 15 2024 11:00:00 GMT+1100 (Australian Eastern Daylight Time)"`: locale- and
    // timezone-dependent text where a `PCDIDateTime` belongs. The field's `BrtBeginPCDFAtbl` declares
    // `fDateInField`, so a reader is told to expect eight bytes and finds a length-prefixed string, which
    // desynchronises every field after it in the row.
    //
    // The bytes below are Excel's own, read out of `ref/05-pivots.xlsb`: year and month as `u16`, then day,
    // hour, minute and second as `u8`. Nothing in the suite covered this path — the sample cache had no date.
    const records = pivotCacheRecordsRecords(
      sampleCache({
        cacheFields: [
          { name: "Region", sharedItems: ["APAC", "EMEA"] },
          { name: "Sold", sharedItems: null }
        ],
        records: [[0, new Date(Date.UTC(2024, 0, 15))]]
      })
    );
    // Four bytes of shared-item index, then eight of date — not four plus a string.
    expect(shapeOf(records)).toEqual([
      ["BrtBeginPivotCacheRecords", 4],
      ["BrtPCRRecord", 12],
      ["BrtEndPivotCacheRecords", 0]
    ]);
    const payload = payloadOf(records, "BrtPCRRecord");
    expect(payload.getUint16(4, true)).toBe(2024);
    expect(payload.getUint16(6, true)).toBe(1);
    expect(payload.getUint8(8)).toBe(15);
    expect(payload.getUint8(9)).toBe(0);
    expect(payload.getUint8(10)).toBe(0);
    expect(payload.getUint8(11)).toBe(0);
  });

  it("still stringifies a value it has no encoding for", () => {
    // The `String()` fallback is deliberate and stays — the point of the fix above is that `Date` is no longer
    // one of the types that falls into it. Asserted so that narrowing it further is a visible decision.
    const records = pivotCacheRecordsRecords(
      sampleCache({
        cacheFields: [
          { name: "Region", sharedItems: ["APAC", "EMEA"] },
          { name: "Odd", sharedItems: null }
        ],
        records: [[0, true as never]]
      })
    );
    // `wideString("true")`: four bytes of `cch` then four UTF-16 characters.
    expect(shapeOf(records)[1]).toEqual(["BrtPCRRecord", 4 + 4 + 8]);
  });

  it("agrees with the definition's cRecords", () => {
    // The two counts are written by different functions from the same model, and a reader trusts both.
    const cache = sampleCache();
    expect(
      payloadOf(pivotCacheDefinitionRecords(cache), "BrtBeginPivotCacheDef").getUint32(17, true)
    ).toBe(
      payloadOf(pivotCacheRecordsRecords(cache), "BrtBeginPivotCacheRecords").getUint32(0, true)
    );
  });

  it("writes an index for a shared-item field and a value for one without", () => {
    const payload = payloadOf(pivotCacheRecordsRecords(sampleCache()), "BrtPCRRecord");
    expect(payload.getUint32(0, true)).toBe(0);
    expect(payload.getFloat64(4, true)).toBe(10);
  });

  it("clamps an index that would point past the item collection", () => {
    // An out-of-range index is a corrupt record rather than a lossy one — the reader follows it into whatever
    // happens to be at that offset. Two items means 0 and 1 are the only valid values.
    const payload = payloadOf(
      pivotCacheRecordsRecords(
        sampleCache({
          records: [
            [7, 1],
            [-3, 2]
          ]
        })
      ),
      "BrtPCRRecord"
    );
    expect(payload.getUint32(0, true)).toBe(1);
  });

  it("writes a string for a text value in a field with no shared items", () => {
    const records = pivotCacheRecordsRecords(
      sampleCache({ cacheFields: [{ name: "F", sharedItems: null }], records: [["hi"]] })
    );
    // Four bytes of character count and two per character.
    expect(shapeOf(records)[1]).toEqual(["BrtPCRRecord", 8]);
    expect(payloadOf(records, "BrtPCRRecord").getUint32(0, true)).toBe(2);
  });
});
