/**
 * `BrtRowHdr`'s three flag bytes.
 *
 * **Why this file exists.** The record's flags were declared as one `u16` at offset 10 followed by a byte,
 * where MS-XLSB 2.4.770 has *three* separate bytes. The writer's only flag — `fUnsynced`, "the height is the
 * row's own" — was therefore written as `0x0002` into the byte at offset 10, which is `fExtraDsc`: pad the
 * bottom of the row. The reader read the same wrong bit, so a custom height round-tripped through this
 * library while Excel saw a row with no manual height and unrequested padding.
 *
 * That mattered beyond the height. `iOutLevel`, `fCollapsed` and `fDyZero` share the byte at offset 11, so
 * hidden rows, grouped rows and collapsed rows were all on the loss list — not because the record had no room
 * for them, but because the field description was wrong. Three features were declared unsupported to describe
 * a mistake.
 *
 * Every assertion here is against the *specification's* offsets rather than against what the encoder
 * produces, because the previous tests did the latter and passed on the wrong layout for as long as it stood.
 */

import { extractAll } from "@archive/unzip/extract";
import { Cell, Row, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { encodeRowHeader } from "@excel/xlsb/write/rows";
import { describe, expect, it } from "vitest";

/** The record MS-XLSB 2.4.770 describes, as offsets into the payload. */
const OFFSET = {
  row: 0,
  styleIndex: 4,
  heightTwips: 8,
  /** `fExtraAsc`, `fExtraDsc`, then six reserved bits. */
  ascenderDescender: 10,
  /** `iOutLevel` in the low three bits, then `fCollapsed`, `fDyZero`, `fUnsynced`, `fGhostDirty`. */
  flags: 11,
  /** `fPhShow`, then seven reserved bits. */
  phoneticGuide: 12,
  columnSpanCount: 13
} as const;

const FLAG = {
  outlineLevel: 0x07,
  collapsed: 1 << 3,
  hidden: 1 << 4,
  unsynced: 1 << 5
} as const;

/** A `DataView` over one encoded row header. */
function header(
  row: Parameters<typeof encodeRowHeader>[0],
  span?: { first: number; last: number }
): DataView {
  const bytes = encodeRowHeader(row, 0, span);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
}

describe("BrtRowHdr, against the specification's own offsets", () => {
  it("is twenty-five bytes with one column span", () => {
    // The worked example in the External References chapter declares `0x19`. It was 24 while the two flag
    // bytes were one `u16`, and 24 is a length no `BrtRowHdr` Excel writes ever has.
    expect(encodeRowHeader({ row: 0 }, 0, { first: 0, last: 0 })).toHaveLength(0x19);
    // The same length without a span: `ccolspan` is still 1 and the bounds are still written, because a row
    // with no cells is not a shape the corpus contains and a shorter form would be unobserved.
    expect(encodeRowHeader({ row: 0 }, 0, undefined)).toHaveLength(0x19);
  });

  it("leaves the ascender/descender byte alone", () => {
    // This is where `fUnsynced` used to land. `fExtraDsc` at bit 1 pads the bottom of the row, which nothing
    // in the model asks for — so the byte is 0 whatever else is set.
    expect(header({ row: 0 }).getUint8(OFFSET.ascenderDescender)).toBe(0);
    expect(header({ row: 0, heightPoints: 24 }).getUint8(OFFSET.ascenderDescender)).toBe(0);
    expect(
      header({ row: 0, hidden: true, outlineLevel: 3, collapsed: true }).getUint8(
        OFFSET.ascenderDescender
      )
    ).toBe(0);
  });

  it("puts fUnsynced at bit 5 of the second flag byte, and only for a custom height", () => {
    expect(header({ row: 0 }).getUint8(OFFSET.flags) & FLAG.unsynced).toBe(0);
    expect(header({ row: 0, heightPoints: 24 }).getUint8(OFFSET.flags) & FLAG.unsynced).toBe(
      FLAG.unsynced
    );
    // And the height itself, in twips: 24 × 20.
    expect(header({ row: 0, heightPoints: 24 }).getUint16(OFFSET.heightTwips, true)).toBe(480);
  });

  it("carries iOutLevel in the low three bits, bounded to what the field can hold", () => {
    expect(header({ row: 0, outlineLevel: 0 }).getUint8(OFFSET.flags) & FLAG.outlineLevel).toBe(0);
    expect(header({ row: 0, outlineLevel: 5 }).getUint8(OFFSET.flags) & FLAG.outlineLevel).toBe(5);
    expect(header({ row: 0, outlineLevel: 7 }).getUint8(OFFSET.flags) & FLAG.outlineLevel).toBe(7);
    // Three bits hold 0–7. A level above that is clamped rather than allowed to overflow into
    // `fCollapsed` — an outline level of 8 would otherwise read as level 0 *and* a collapsed row.
    const overflowed = header({ row: 0, outlineLevel: 9 }).getUint8(OFFSET.flags);
    expect(overflowed & FLAG.outlineLevel).toBe(7);
    expect(overflowed & FLAG.collapsed).toBe(0);
  });

  it("keeps the four flags independent", () => {
    // Each occupies its own bit, so setting all four is their bitwise union and nothing more. A flag written
    // at the wrong offset would show up here as a byte that is not the sum of its parts.
    const all = header({
      row: 0,
      heightPoints: 20,
      hidden: true,
      collapsed: true,
      outlineLevel: 2
    }).getUint8(OFFSET.flags);
    expect(all).toBe(2 | FLAG.collapsed | FLAG.hidden | FLAG.unsynced);
    expect(header({ row: 0, hidden: true }).getUint8(OFFSET.flags)).toBe(FLAG.hidden);
    expect(header({ row: 0, collapsed: true }).getUint8(OFFSET.flags)).toBe(FLAG.collapsed);
  });

  it("leaves the phonetic-guide byte and the row's own fields where they belong", () => {
    const view = header({ row: 6, heightPoints: 15 }, { first: 1, last: 3 });
    expect(view.getUint32(OFFSET.row, true)).toBe(6);
    expect(view.getUint32(OFFSET.styleIndex, true)).toBe(0);
    expect(view.getUint8(OFFSET.phoneticGuide)).toBe(0);
    // Always one span, so the count is 1 and the two bounds follow it.
    expect(view.getUint32(OFFSET.columnSpanCount, true)).toBe(1);
    expect(view.getUint32(OFFSET.columnSpanCount + 4, true)).toBe(1);
    expect(view.getUint32(OFFSET.columnSpanCount + 8, true)).toBe(3);
  });
});

describe("through a package", () => {
  /** The row headers a one-sheet workbook writes, keyed by one-based row. */
  async function writtenHeaders(
    build: (sheet: Worksheet.Handle) => void
  ): Promise<Map<number, DataView>> {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a"], ["b"], ["c"]]);
    build(sheet);
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const path = [...parts.keys()].find(name => /worksheets\/sheet\d+\.bin$/.test(name))!;
    const headers = new Map<number, DataView>();
    for (const entry of iterateInterpretableRecords(parts.get(path)!.data, "s")) {
      if (recordSpec(entry.id)?.name !== "BrtRowHdr") {
        continue;
      }
      const view = new DataView(
        entry.payload!.buffer,
        entry.payload!.byteOffset,
        entry.payload!.length
      );
      headers.set(view.getUint32(OFFSET.row, true) + 1, view);
    }
    return headers;
  }

  it("writes the model's hidden, grouped and collapsed rows", async () => {
    const headers = await writtenHeaders(sheet => {
      const model = Worksheet.getModel(sheet);
      model.rows = (model.rows ?? []).map(row =>
        row.number === 2 ? { ...row, hidden: true, outlineLevel: 2, collapsed: true } : row
      );
      Worksheet.setModel(sheet, model);
    });
    expect(headers.get(2)!.getUint8(OFFSET.flags)).toBe(2 | FLAG.collapsed | FLAG.hidden);
    // The rows either side carry none of it, so the flags belong to the row and not to the sheet.
    expect(headers.get(1)!.getUint8(OFFSET.flags)).toBe(0);
    expect(headers.get(3)!.getUint8(OFFSET.flags)).toBe(0);
  });

  it("round-trips all three across generations", async () => {
    // Three generations because reader and writer agreeing on a *wrong* offset is exactly how the previous
    // layout survived: a single round trip proves they agree, not that either is right.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a"], ["b"], ["c"]]);
    const model = Worksheet.getModel(sheet);
    model.rows = (model.rows ?? []).map(row =>
      row.number === 2 ? { ...row, hidden: true, outlineLevel: 2, collapsed: true } : row
    );
    Worksheet.setModel(sheet, model);
    let bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    for (let generation = 0; generation < 3; generation += 1) {
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);
      const row = Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!).rows?.find(
        entry => entry.number === 2
      );
      expect(row).toMatchObject({ hidden: true, outlineLevel: 2, collapsed: true });
      bytes = await Workbook.toBuffer(reopened, { format: "xlsb" });
    }
  });

  it("round-trips a custom height, which is what fUnsynced is for", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", 2);
    Row.setHeight(sheet, 2, 40);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const rows = Worksheet.getModel(Workbook.getWorksheet(reopened, "S")!).rows ?? [];
    expect(rows.find(row => row.number === 2)?.height).toBe(40);
    // And the row that was never given one does not come back with the default as though it had been chosen.
    expect(rows.find(row => row.number === 1)?.height).toBeUndefined();
  });

  it("reports no loss for any of the three", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Worksheet.addAoa(sheet, [["a"], ["b"]]);
    const model = Worksheet.getModel(sheet);
    model.rows = (model.rows ?? []).map(row =>
      row.number === 2 ? { ...row, hidden: true, outlineLevel: 1, collapsed: true } : row
    );
    Worksheet.setModel(sheet, model);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});
