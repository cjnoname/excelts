import { extractAll } from "@archive/unzip/extract";
import { Cell, Pivot, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * A pivot cache has to name the sheet and range its data is actually in.
 *
 * Converting XLSX→XLSB used to substitute the pivot's *own* sheet and a range anchored at `A1`, on the stated grounds
 * that the reader did not keep `worksheetSource`. It does: `cacheDefinition` carries `sourceSheet` and `sourceRef`. So a
 * cache whose data sits in `Data!A1:C4` was written naming the sheet the pivot is *displayed* on.
 *
 * Not cosmetic. `refreshOnLoad` is set on every cache this writer emits, so the first refresh reads the range the cache
 * names — and a cache pointing at its own output is empty or circular. The cached values make it look correct until
 * someone refreshes, which is the worst shape a defect can take.
 *
 * Asserted by searching the record for the UTF-16 sheet name rather than by decoding it at a fixed offset: the record
 * carries an FRT header, and an offset assumption is how two earlier readings of this record came out as noise.
 */
function containsUtf16(bytes: Uint8Array, text: string): boolean {
  const needle = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    needle[index * 2] = text.charCodeAt(index) & 0xff;
    needle[index * 2 + 1] = text.charCodeAt(index) >> 8;
  }
  for (let start = 0; start + needle.length <= bytes.length; start += 1) {
    if (needle.every((byte, offset) => bytes[start + offset] === byte)) {
      return true;
    }
  }
  return false;
}

async function sourceRangeRecords(bytes: Uint8Array): Promise<readonly Uint8Array[]> {
  const parts = await extractAll(bytes);
  const out: Uint8Array[] = [];
  for (const path of [...parts.keys()].filter(name =>
    /pivotCache\/pivotCacheDefinition\d+\.bin$/.test(name)
  )) {
    for (const record of iterateInterpretableRecords(parts.get(path)!.data, "x")) {
      if (recordSpec(record.id)?.name === "BrtBeginPCDSRange") {
        out.push(record.payload);
      }
    }
  }
  return out;
}

/** A workbook whose pivot source is on a *different* sheet from the pivot, which is the case that distinguishes them. */
async function crossSheetPivot(): Promise<Uint8Array> {
  const workbook = Workbook.create();
  const data = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(data, "A1", "Region");
  Cell.setValue(data, "B1", "Units");
  ["APAC", "EMEA", "AMER"].forEach((region, index) => {
    Cell.setValue(data, `A${index + 2}`, region);
    Cell.setValue(data, `B${index + 2}`, (index + 1) * 10);
  });
  const report = Workbook.addWorksheet(workbook, "Report");
  Pivot.add(report, {
    sourceSheet: data,
    ref: "A3",
    rows: ["Region"],
    columns: [],
    values: ["Units"],
    metric: "sum"
  } as never);
  return Workbook.toBuffer(workbook, { format: "xlsx" });
}

describe("pivot cache source, converting XLSX to XLSB", () => {
  it("names the sheet the data is on", async () => {
    const xlsx = await crossSheetPivot();
    const workbook = Workbook.create();
    await Workbook.read(workbook, xlsx);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const records = await sourceRangeRecords(written);
    expect(records.length).toBeGreaterThan(0);
    for (const payload of records) {
      expect(containsUtf16(payload, "Data")).toBe(true);
    }
  });

  it("does not name the sheet the pivot is displayed on", async () => {
    // The failing half before the fix: `Report` is where the pivot lives, not where its data is.
    const xlsx = await crossSheetPivot();
    const workbook = Workbook.create();
    await Workbook.read(workbook, xlsx);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    for (const payload of await sourceRangeRecords(written)) {
      expect(containsUtf16(payload, "Report")).toBe(false);
    }
  });

  it("still works for a pivot built in memory, where the source is live", async () => {
    // The other branch of `pivotCache`: a pivot created through `Pivot.add` carries a live worksheet adapter and never
    // reaches the parsed path. It must keep naming its source too.
    const workbook = Workbook.create();
    const data = Workbook.addWorksheet(workbook, "Numbers");
    Cell.setValue(data, "A1", "K");
    Cell.setValue(data, "B1", "V");
    Cell.setValue(data, "A2", "x");
    Cell.setValue(data, "B2", 1);
    const report = Workbook.addWorksheet(workbook, "Out");
    Pivot.add(report, {
      sourceSheet: data,
      ref: "A3",
      rows: ["K"],
      columns: [],
      values: ["V"],
      metric: "sum"
    } as never);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    for (const payload of await sourceRangeRecords(written)) {
      expect(containsUtf16(payload, "Numbers")).toBe(true);
    }
  });
});
