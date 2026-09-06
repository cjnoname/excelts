import { extractAll } from "@archive/unzip/extract";
import { Cell, Pivot, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * `BrtWsDim` counts a pivot table's anchor, because a pivot sheet has no cell records of its own.
 *
 * The body is Excel's to render, so a dimension derived from rows alone declared the sheet **empty** — `0..0`, which
 * Excel never writes: all 21 `BrtWsDim` records across the oracle's reference workbooks state a real extent. Read back
 * through this library the sheet looked fine either way, since the pivot definition is what carries the content.
 *
 * What this does *not* claim: Excel's extent is the range after a refresh (rows 2..6 against a declared `A3:B4`), and
 * that is not derivable from the file. The anchor is the honest answer — the sheet is reported as occupied, over the
 * region the file names.
 */
async function dimensionsOf(
  bytes: Uint8Array
): Promise<Map<string, [number, number, number, number]>> {
  const parts = await extractAll(bytes);
  const out = new Map<string, [number, number, number, number]>();
  for (const path of [...parts.keys()].filter(name => /worksheets\/sheet\d+\.bin$/.test(name))) {
    for (const record of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
      if (recordSpec(record.id)?.name !== "BrtWsDim") {
        continue;
      }
      const view = new DataView(
        record.payload.buffer,
        record.payload.byteOffset,
        record.payload.length
      );
      out.set(path.split("/").pop()!, [
        view.getUint32(0, true),
        view.getUint32(4, true),
        view.getUint32(8, true),
        view.getUint32(12, true)
      ]);
    }
  }
  return out;
}

async function withPivotAt(ref: string): Promise<Uint8Array> {
  const workbook = Workbook.create();
  const source = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(source, "A1", "Region");
  Cell.setValue(source, "B1", "Units");
  Cell.setValue(source, "A2", "APAC");
  Cell.setValue(source, "B2", 5);
  Cell.setValue(source, "A3", "EMEA");
  Cell.setValue(source, "B3", 7);
  const sheet = Workbook.addWorksheet(workbook, "Report");
  Pivot.add(sheet, {
    sourceSheet: source,
    ref,
    rows: ["Region"],
    columns: [],
    values: ["Units"],
    metric: "sum"
  } as never);
  return Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
}

describe("BrtWsDim on a pivot sheet", () => {
  it("does not declare the sheet empty", async () => {
    const dimensions = await dimensionsOf(await withPivotAt("A3"));
    // sheet2 is the pivot sheet; sheet1 holds the source data.
    const pivotSheet = dimensions.get("sheet2.bin");
    expect(pivotSheet).toBeDefined();
    expect(pivotSheet).not.toEqual([0, 0, 0, 0]);
  });

  it("starts the extent at the anchor's row", async () => {
    // `A3` is row index 2. Pinned to the anchor rather than to a literal so that moving the pivot moves the assertion.
    const dimensions = await dimensionsOf(await withPivotAt("A3"));
    expect(dimensions.get("sheet2.bin")![0]).toBe(2);
  });

  it("moves with the anchor", async () => {
    // The strongest form of the previous assertion: an anchor further down must widen the extent, which a hard-coded
    // repair would not do.
    const low = await dimensionsOf(await withPivotAt("A3"));
    const high = await dimensionsOf(await withPivotAt("C10"));
    expect(high.get("sheet2.bin")![0]).toBeGreaterThan(low.get("sheet2.bin")![0]);
    expect(high.get("sheet2.bin")![2]).toBeGreaterThan(low.get("sheet2.bin")![2]);
  });

  it("leaves an ordinary sheet's extent driven by its cells", async () => {
    // The fix must not widen a sheet that has no pivot: the source sheet holds A1:B3.
    const dimensions = await dimensionsOf(await withPivotAt("A3"));
    expect(dimensions.get("sheet1.bin")).toEqual([0, 2, 0, 1]);
  });
});
