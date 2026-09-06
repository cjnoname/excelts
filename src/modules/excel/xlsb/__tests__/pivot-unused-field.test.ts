import { extractAll } from "@archive/unzip/extract";
import { Cell, Pivot, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * A source column that **no axis uses** gets no shared items, and its values travel inline in each cache record.
 *
 * The two halves are one decision and have to agree: shared items mean the record stores a 4-byte index, and no shared
 * items mean the record stores the value itself — 8 structured bytes for a date. A field with items in the definition
 * and inline values in the records (or the reverse) desynchronises every field after it in the row.
 *
 * **This file previously asserted the opposite, with a table of measurements to back it.** Excel's save of the oracle's
 * `05-pivots` appeared to materialise three `BrtPCDIDatetime` for an unused `Sold` column — but the caches were being
 * paired *by filename*, and Excel's `pivotCacheDefinition3.bin` serves the sheet this library's
 * `pivotCacheDefinition1.bin` serves. Paired by the pivot table that points at them, all three record parts are
 * byte-identical and the rule is simply the axis. Two earlier attempts at this same field failed the same way, one of
 * them taking the oracle from 100 differences to 155.
 *
 * The view assertions below are kept, and they are the durable half: two places in the view writer used
 * `itemCount > 0` as a proxy for "the view places this field somewhere", which is only true while nothing else can give
 * a field items. They now read the axis, so the flag and the item list cannot disagree.
 */
async function pivotParts(): Promise<{
  readonly cache: Map<string, number>;
  readonly view: Map<string, number>;
  readonly fieldFlags: readonly number[];
  readonly recordLengths: readonly number[];
}> {
  const workbook = Workbook.create();
  const source = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(source, "A1", "Region");
  Cell.setValue(source, "B1", "Units");
  Cell.setValue(source, "C1", "Sold");
  const rows: [string, number, Date][] = [
    ["APAC", 10, new Date(Date.UTC(2024, 0, 15))],
    ["EMEA", 20, new Date(Date.UTC(2024, 1, 20))],
    ["AMER", 30, new Date(Date.UTC(2024, 2, 25))]
  ];
  rows.forEach(([region, units, sold], index) => {
    const row = index + 2;
    Cell.setValue(source, `A${row}`, region);
    Cell.setValue(source, `B${row}`, units);
    Cell.setValue(source, `C${row}`, sold);
  });
  const sheet = Workbook.addWorksheet(workbook, "Report");
  // `Sold` is on no axis at all — neither a row, a column, a page nor a value.
  Pivot.add(sheet, {
    sourceSheet: source,
    ref: "A3",
    rows: ["Region"],
    columns: [],
    values: ["Units"],
    metric: "sum"
  } as never);
  const parts = await extractAll(
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  const count = (pattern: RegExp): Map<string, number> => {
    const out = new Map<string, number>();
    for (const path of [...parts.keys()].filter(name => pattern.test(name))) {
      for (const record of iterateInterpretableRecords(parts.get(path)!.data, "x")) {
        const name = recordSpec(record.id)?.name ?? `?${record.id}`;
        out.set(name, (out.get(name) ?? 0) + 1);
      }
    }
    return out;
  };
  const fieldFlags: number[] = [];
  for (const path of [...parts.keys()].filter(name =>
    /pivotTables\/pivotTable\d+\.bin$/.test(name)
  )) {
    for (const record of iterateInterpretableRecords(parts.get(path)!.data, "x")) {
      if (recordSpec(record.id)?.name !== "BrtBeginSXVD") {
        continue;
      }
      fieldFlags.push(
        new DataView(
          record.payload.buffer,
          record.payload.byteOffset,
          record.payload.length
        ).getUint16(0, true)
      );
    }
  }
  const recordLengths: number[] = [];
  for (const path of [...parts.keys()].filter(name =>
    /pivotCache\/pivotCacheRecords\d+\.bin$/.test(name)
  )) {
    for (const record of iterateInterpretableRecords(parts.get(path)!.data, "x")) {
      if (recordSpec(record.id)?.name === "BrtPCRRecord") {
        recordLengths.push(record.payload.length);
      }
    }
  }
  return {
    cache: count(/pivotCache\/pivotCacheDefinition\d+\.bin$/),
    view: count(/pivotTables\/pivotTable\d+\.bin$/),
    fieldFlags,
    recordLengths
  };
}

describe("an unused date column in a pivot cache", () => {
  it("gets no shared items in the cache", async () => {
    // `Sold` is on no axis, so the definition enumerates nothing for it — which is what Excel does once its caches are
    // paired with this library's by the pivot they serve rather than by their number.
    const { cache } = await pivotParts();
    expect(cache.get("BrtPCDIDatetime") ?? 0).toBe(0);
  });

  it("carries the unused column's dates inline in each record", async () => {
    // The other half of the same decision, and the reason getting it wrong is not cosmetic: with no shared items the
    // record has to hold the value, and a reader recovers its type from the field's `BrtBeginPCDFAtbl` flags. A record
    // that stored an index here would point into a collection that does not exist.
    //
    // Three source rows, each `BrtPCRRecord` holding: index into Region's items (4 B) + Units as a double (8 B) +
    // Sold as a `PCDIDateTime` (8 B) = 20 bytes.
    const { recordLengths } = await pivotParts();
    expect(recordLengths).toEqual([20, 20, 20]);
  });

  it("still gives an axis field its shared items", async () => {
    // The fix must not swing the other way: `Region` is a row field, so its three values are enumerated and its
    // records store indices into them.
    const { cache } = await pivotParts();
    expect(cache.get("BrtPCDIString") ?? 0).toBe(3);
    // `Units` is a value field, described by min/max rather than by items.
    expect(cache.get("BrtPCDIReal") ?? 0).toBe(0);
    expect(cache.get("BrtPCDIRk") ?? 0).toBe(0);
  });

  it("gets no item list in the view", async () => {
    // One field is on an axis (`Region`), so exactly one `BrtBeginSXVIs` is expected — not two.
    const { view } = await pivotParts();
    expect(view.get("BrtBeginSXVIs") ?? 0).toBe(1);
  });

  it("gets no defaultSubtotal flag in the view", async () => {
    // `BrtBeginSXVD`'s first 16 bits: `0x0001` claims a default subtotal. Excel writes `0x0000` for a field it places
    // nowhere, and this flag has to agree with the item list above — deriving both from `itemCount` is what let them
    // disagree.
    const { fieldFlags } = await pivotParts();
    expect(fieldFlags).toHaveLength(3);
    expect(fieldFlags[0]! & 0x0001).toBe(0x0001);
    expect(fieldFlags[1]! & 0x0001).toBe(0);
    expect(fieldFlags[2]! & 0x0001).toBe(0);
  });
});
