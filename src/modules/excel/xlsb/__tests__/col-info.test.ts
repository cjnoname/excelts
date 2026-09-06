/**
 * `BrtColInfo`'s flag word.
 *
 * **Why this file exists.** Four column features — hidden, grouped, collapsed and best-fit — were reported as
 * things XLSX could carry and XLSB could not. The record's flag word had room for all of them and the field
 * table described it correctly; the writer set `fUserSet` and nothing else:
 *
 * ```ts
 * .writeUint16(0x02)
 * ```
 *
 * So this is the *other* shape the same class of defect takes. `BrtRowHdr` lost three features to a wrong
 * field description; `BrtColInfo` lost four to a right one that nobody filled in. Neither needed a new record.
 *
 * Assertions are against the offsets and bit positions in MS-XLSB 2.4.45 rather than against what the encoder
 * produces, for the reason the row-header tests give: a test written from the implementation agrees with it.
 */

import { extractAll } from "@archive/unzip/extract";
import { Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** Offsets into the payload, per MS-XLSB 2.4.45. */
const OFFSET = { colFirst: 0, colLast: 4, width: 8, styleIndex: 12, flags: 16 } as const;

/**
 * The flag word's bits.
 *
 * `iOutLevel` sits at **8–10**, not adjacent to the four single bits below it: bits 4–7 are reserved. A layout
 * that packed the outline level next to `fPhonetic` would put level 1 in `reserved1`, which Excel is entitled
 * to reject — and level 4 would land in `iOutLevel`'s low bit and read as level 1.
 */
const FLAG = {
  hidden: 1 << 0,
  userSet: 1 << 1,
  bestFit: 1 << 2,
  phonetic: 1 << 3,
  outlineShift: 8,
  outlineMask: 0x07 << 8,
  collapsed: 1 << 12
} as const;

/** The `BrtColInfo` records a one-sheet workbook writes, keyed by one-based first column. */
async function writtenColumns(
  cols: readonly Record<string, unknown>[],
  outlineLevelCol?: number
): Promise<Map<number, DataView>> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Worksheet.addAoa(sheet, [["a", "b", "c"]]);
  const model = Worksheet.getModel(sheet);
  (model as { cols?: unknown }).cols = cols;
  // **`collapsed` is derived, not stored.** `columnCollapsed` returns
  // `outlineLevel >= worksheet.properties.outlineLevelCol`, and that property defaults to 0 — so *every*
  // grouped column reports itself collapsed unless the sheet declares an outline depth. That is the model's
  // own semantics, with a test of its own in `core/__tests__/worksheet.views.test.ts`, and the writer is
  // faithfully reflecting it. Raising the threshold is how the outline level is asserted in isolation here.
  if (outlineLevelCol !== undefined) {
    (model as { properties?: Record<string, unknown> }).properties = {
      ...(model as { properties?: Record<string, unknown> }).properties,
      outlineLevelCol
    };
  }
  Worksheet.setModel(sheet, model);
  const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  const path = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
  const found = new Map<number, DataView>();
  for (const entry of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
    if (recordSpec(entry.id)?.name !== "BrtColInfo") {
      continue;
    }
    const view = new DataView(
      entry.payload!.buffer,
      entry.payload!.byteOffset,
      entry.payload!.length
    );
    found.set(view.getUint32(OFFSET.colFirst, true) + 1, view);
  }
  return found;
}

describe("BrtColInfo, against the specification's own bit positions", () => {
  it("is eighteen bytes: four fields and one flag word", () => {
    // Four `u32` and a `u16`. This is the length that identified the fields in the first place — the third
    // held 2742, which is 10.71 characters in 1/256ths, the default Calibri 11 width.
    return writtenColumns([{ min: 1, max: 1, width: 12, isCustomWidth: true }]).then(columns => {
      expect(columns.get(1)!.byteLength).toBe(18);
    });
  });

  it("writes each flag in its own bit", async () => {
    const columns = await writtenColumns([
      { min: 1, max: 1, hidden: true },
      { min: 2, max: 2, bestFit: true },
      { min: 3, max: 3, outlineLevel: 2 }
    ]);
    expect(columns.get(1)!.getUint16(OFFSET.flags, true) & FLAG.hidden).toBe(FLAG.hidden);
    expect(columns.get(2)!.getUint16(OFFSET.flags, true) & FLAG.bestFit).toBe(FLAG.bestFit);
    // Collapsed comes from the outline level being at or above the sheet's declared depth, which is 0 here.
    expect(columns.get(3)!.getUint16(OFFSET.flags, true) & FLAG.collapsed).toBe(FLAG.collapsed);
    // `fPhonetic` is never written: nothing in the model asks for it, and it sits between `fBestFit` and the
    // reserved bits, so a flag written one place too high would land in it.
    for (const column of columns.values()) {
      expect(column.getUint16(OFFSET.flags, true) & FLAG.phonetic).toBe(0);
    }
  });

  it("puts iOutLevel at bits 8 to 10, above four reserved bits", async () => {
    // Threshold raised past every level below, so `fCollapsed` stays clear and the outline bits are the only
    // thing under test.
    const columns = await writtenColumns(
      [
        { min: 1, max: 1, outlineLevel: 1 },
        { min: 2, max: 2, outlineLevel: 7 },
        { min: 3, max: 3, outlineLevel: 4 }
      ],
      8
    );
    const levelOf = (column: number): number =>
      (columns.get(column)!.getUint16(OFFSET.flags, true) & FLAG.outlineMask) >> FLAG.outlineShift;
    expect(levelOf(1)).toBe(1);
    expect(levelOf(2)).toBe(7);
    expect(levelOf(3)).toBe(4);
    // And nothing lands in `reserved1`, bits 4 through 7, which is where the level would go if it were packed
    // next to the single bits below it.
    for (const column of columns.values()) {
      expect(column.getUint16(OFFSET.flags, true) & 0x00f0).toBe(0);
    }
  });

  it("clamps an outline level the three bits cannot hold", async () => {
    // 8 would overflow into bit 11 — `unused` — and read as level 0. Clamping keeps it inside the field.
    const columns = await writtenColumns([{ min: 1, max: 1, outlineLevel: 9 }], 10);
    const flags = columns.get(1)!.getUint16(OFFSET.flags, true);
    expect((flags & FLAG.outlineMask) >> FLAG.outlineShift).toBe(7);
    expect(flags & (1 << 11)).toBe(0);
    expect(flags & FLAG.collapsed).toBe(0);
  });

  it("sets fUserSet on every column that has a record at all", async () => {
    // **This test used to assert the opposite, with an argument for it.** It said `fUserSet` belonged only to a width
    // the author chose, derived from `isCustomWidth`, on the reasoning that `setModel` fills the default width into
    // every column so presence cannot distinguish one. That reasoning is sound and the conclusion is wrong: Excel
    // sets the bit on all ten `BrtColInfo` records across the oracle's reference workbooks, including a column whose
    // width is the default and whose only distinction is that it is hidden.
    //
    // The flag asks a wider question than the old derivation answered. A column with a record in `<cols>` is one
    // somebody set *something* on, and width is not the only thing that can be set.
    const columns = await writtenColumns([
      { min: 1, max: 1, hidden: true },
      { min: 2, max: 2, width: 20, isCustomWidth: true }
    ]);
    expect(columns.get(1)!.getUint16(OFFSET.flags, true) & FLAG.userSet).toBe(FLAG.userSet);
    expect(columns.get(2)!.getUint16(OFFSET.flags, true) & FLAG.userSet).toBe(FLAG.userSet);
    // 20 characters × 256.
    expect(columns.get(2)!.getUint32(OFFSET.width, true)).toBe(20 * 256);
  });

  it("writes a record for a column that has flags but no width", async () => {
    // This used to return early on a missing width, so a hidden column with no width of its own produced no
    // `BrtColInfo` at all — the flags had nowhere to live and the feature looked unsupported.
    const columns = await writtenColumns([{ min: 2, max: 2, hidden: true }]);
    expect(columns.has(2)).toBe(true);
    expect(columns.get(2)!.getUint16(OFFSET.flags, true) & FLAG.hidden).toBe(FLAG.hidden);
  });

  it("applies one record to a span of columns", async () => {
    const columns = await writtenColumns([{ min: 2, max: 4, hidden: true, outlineLevel: 2 }]);
    const record = columns.get(2)!;
    expect(record.getUint32(OFFSET.colFirst, true)).toBe(1);
    expect(record.getUint32(OFFSET.colLast, true)).toBe(3);
  });
});

describe("through a round trip", () => {
  it("brings all four back, across generations", async () => {
    // Three generations because reader and writer agreeing on a wrong bit is how a defect of this kind
    // survives: one round trip proves they agree, not that either matches the specification.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a", "b", "c"]]);
    const model = Worksheet.getModel(sheet);
    (model as { cols?: unknown }).cols = [
      { min: 1, max: 1, hidden: true },
      { min: 2, max: 2, outlineLevel: 3, collapsed: true },
      { min: 3, max: 3, width: 20, isCustomWidth: true, bestFit: true }
    ];
    Worksheet.setModel(sheet, model);
    let bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    for (let generation = 0; generation < 3; generation += 1) {
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);
      const cols = (Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!).cols ??
        []) as unknown as Record<string, unknown>[];
      expect(cols.find(column => column.min === 1)).toMatchObject({ hidden: true });
      expect(cols.find(column => column.min === 2)).toMatchObject({
        outlineLevel: 3,
        collapsed: true
      });
      expect(cols.find(column => column.min === 3)).toMatchObject({ bestFit: true, width: 20 });
      bytes = await Workbook.toBuffer(reopened, { format: "xlsb" });
    }
  });

  it("does not turn a default width into a chosen one", async () => {
    // The mirror of the `fUserSet` assertion above, read back: a column that was only hidden must not come
    // back claiming its width was set, or every generation would harden the default a little further.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a", "b"]]);
    const model = Worksheet.getModel(sheet);
    (model as { cols?: unknown }).cols = [{ min: 1, max: 1, hidden: true }];
    Worksheet.setModel(sheet, model);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const cols = (Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!).cols ??
      []) as unknown as Record<string, unknown>[];
    expect(cols.find(column => column.min === 1)).toMatchObject({
      hidden: true,
      isCustomWidth: false
    });
  });

  it("reports no loss for any of the four", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a", "b"]]);
    const model = Worksheet.getModel(sheet);
    (model as { cols?: unknown }).cols = [
      { min: 1, max: 1, hidden: true, bestFit: true, outlineLevel: 2, collapsed: true }
    ];
    Worksheet.setModel(sheet, model);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});
