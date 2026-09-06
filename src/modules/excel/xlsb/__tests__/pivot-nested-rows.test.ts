import { extractAll } from "@archive/unzip/extract";
import { Cell, Pivot, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * A pivot line's **outermost** item index is a display position; every inner one is a cache index.
 *
 * That asymmetry is Excel's, and it looks enough like an inconsistency to be worth pinning. For a pivot with two row
 * fields over `APAC / EMEA / AMER` and three ascending dates, Excel writes `[0,2] [1,0] [2,1]`. Neither uniform reading
 * produces those three lines: cache indices throughout give `[0,0] [1,1] [2,2]`, and display positions throughout agree
 * only by coincidence here, because this cache's dates are already in ascending order. Deriving both and checking all
 * three lines is what settled it — an outer index is the line's position on the axis, which is display; an inner index
 * identifies a value, which is the cache.
 *
 * Why it went unnoticed: with a single row field the only field is also the sort key, so the two orderings coincide and
 * nothing can tell them apart. `[0,0]` pairs AMER with January because both happen to be first in their own ordering,
 * which is wrong data rather than an ugly layout.
 */
async function rowLineIndices(): Promise<readonly (readonly number[])[]> {
  const workbook = Workbook.create();
  const source = Workbook.addWorksheet(workbook, "Data");
  Cell.setValue(source, "A1", "Region");
  Cell.setValue(source, "B1", "Units");
  Cell.setValue(source, "C1", "Sold");
  // Deliberately *not* in alphabetical order, so the cache order and the display order differ.
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
  Pivot.add(sheet, {
    sourceSheet: source,
    ref: "A3",
    // Two row fields is the shape that distinguishes the two conventions.
    rows: ["Region", "Sold"],
    columns: [],
    values: ["Units"],
    metric: "sum"
  } as never);
  const parts = await extractAll(
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  const out: number[][] = [];
  for (const path of [...parts.keys()].filter(name =>
    /pivotTables\/pivotTable\d+\.bin$/.test(name)
  )) {
    for (const record of iterateInterpretableRecords(parts.get(path)!.data, "x")) {
      if (recordSpec(record.id)?.name !== "BrtBeginISXVIs") {
        continue;
      }
      const view = new DataView(
        record.payload.buffer,
        record.payload.byteOffset,
        record.payload.length
      );
      const indices: number[] = [];
      for (let offset = 0; offset + 4 <= record.payload.length; offset += 4) {
        indices.push(view.getUint32(offset, true));
      }
      out.push(indices);
    }
  }
  return out;
}

describe("nested pivot row lines", () => {
  it("pairs each outer item with the inner value that belongs to it", async () => {
    // The three two-element lines, which are the data rows. `[0,2]` is AMER — display position 0, since it sorts first
    // — with the March date, cache index 2. Getting this wrong pairs AMER with January.
    const lines = (await rowLineIndices()).filter(line => line.length === 2);
    expect(lines).toEqual([
      [0, 2],
      [1, 0],
      [2, 1]
    ]);
  });

  it("orders the lines by the outer field's display position", async () => {
    // A consequence worth asserting separately: the outer indices run 0,1,2 in order, which they would not if the
    // lines were sorted by cache index.
    const lines = (await rowLineIndices()).filter(line => line.length === 2);
    expect(lines.map(line => line[0])).toEqual([0, 1, 2]);
  });

  it("emits a subtotal line per outer group", async () => {
    // One-element lines close each outer group, and their index is the same display position as the group they close.
    const lines = await rowLineIndices();
    const subtotals = lines.filter(line => line.length === 1);
    // Three groups plus the grand total.
    expect(subtotals).toHaveLength(4);
    expect(subtotals.slice(0, 3).map(line => line[0])).toEqual([0, 1, 2]);
  });
});
