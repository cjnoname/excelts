import { extractAll } from "@archive/unzip/extract";
/**
 * Sheet visibility, merged ranges, column widths and row heights through XLSB.
 *
 * Every layout here was established from Excel's own output rather than assumed, and two of them
 * were confirmed by a value that could not be a coincidence: a workbook whose three sheets are
 * named `Visible`, `Hidden` and `VeryHidden` carries 0, 1 and 2, and a default column carries
 * 2742 — which is 10.71 characters, the width of a default Calibri 11 column.
 */
import { ZipArchive } from "@archive/zip";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { encodeFont } from "@excel/xlsb/font";
import { mergesFromModel } from "@excel/xlsb/write/model-adapter";
import { describeBiffStream } from "@test/biff-dump";
import { biff, rowHeader } from "@test/biff-fixture";
import { describeWorkbook } from "@test/workbook-describe";
import { describe, expect, it } from "vitest";

async function roundTrip(source: Workbook.Handle): Promise<Workbook.Handle> {
  const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
  await expectValidXlsb(bytes, { includeWarnings: true });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  return reopened;
}

async function sheetListing(source: Workbook.Handle, path = "xl/worksheets/sheet1.bin") {
  const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
  return describeBiffStream(entries.get(path)!.data);
}

describe("sheet visibility", () => {
  it("carries all three states", async () => {
    // 0, 1 and 2 in a workbook whose sheets are named after them is as direct a confirmation as
    // reference data gets.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Shown"), "A1", 1);
    Workbook.addWorksheet(source, "Tucked", { state: "hidden" });
    Workbook.addWorksheet(source, "Gone", { state: "veryHidden" });

    const reopened = await roundTrip(source);
    expect(
      Workbook.getWorksheets(reopened).map(sheet => [
        Worksheet.getName(sheet),
        Worksheet.getModel(sheet).state
      ])
    ).toEqual([
      ["Shown", "visible"],
      ["Tucked", "hidden"],
      ["Gone", "veryHidden"]
    ]);
  });

  it("writes the state into the workbook part", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "A"), "A1", 1);
    Workbook.addWorksheet(source, "B", { state: "hidden" });

    const listing = await sheetListing(source, "xl/workbook.bin");
    expect(listing).toMatch(/BrtBundleSh state=0 tabId=1 relId="rId1" name="A"/);
    expect(listing).toMatch(/BrtBundleSh state=1 tabId=2 relId="rId2" name="B"/);
  });

  it("treats an unknown state as visible rather than failing", async () => {
    // A producer using a value this library does not know should not make the sheet
    // unreadable — the worst outcome for an unrecognised visibility is a visible sheet.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Only"), "A1", 1);
    const reopened = await roundTrip(source);
    expect(Worksheet.getModel(Workbook.getWorksheets(reopened)[0]!).state).toBe("visible");
  });
});

describe("merged ranges", () => {
  it("round-trips several merges", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Merged");
    Cell.setValue(sheet, "A1", "title");
    Worksheet.merge(sheet, "A1:C1");
    Cell.setValue(sheet, "A3", "block");
    Worksheet.merge(sheet, "A3:B5");

    const reopened = await roundTrip(source);
    expect(Worksheet.getModel(Workbook.getWorksheets(reopened)[0]!).mergeCells).toEqual([
      "A1:C1",
      "A3:B5"
    ]);
  });

  it("keeps the master cell's value", async () => {
    // Merging clears every covered cell but the master, so a reader that merged before writing
    // the cells would erase the value it was about to place.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Merged");
    Cell.setValue(sheet, "A1", "kept");
    Worksheet.merge(sheet, "A1:C2");

    const reopened = await roundTrip(source);
    expect(Cell.getValue(Workbook.getWorksheets(reopened)[0]!, "A1")).toBe("kept");
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("writes the merge collection after the cell data", async () => {
    // Where the ordering rules place it, and where a consumer wants it: read the cells, then
    // learn which of them are covered.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Merged");
    Cell.setValue(sheet, "A1", 1);
    Worksheet.merge(sheet, "A1:B1");

    const listing = await sheetListing(source);
    expect(listing.indexOf("BrtEndSheetData")).toBeLessThan(listing.indexOf("BrtBeginMergeCells"));
    expect(listing).toContain("BrtBeginMergeCells cmcs=1");
    expect(listing).toContain("BrtMergeCell ref=0:0×0:1");
  });

  it("emits no collection when there are no merges", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 1);
    expect(await sheetListing(source)).not.toContain("MergeCells");
  });
});

describe("column widths", () => {
  it("round-trips a width per column", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Wide");
    Cell.setValue(sheet, "A1", 1);
    Column.setWidth(sheet, 1, 22.5);
    Column.setWidth(sheet, 2, 22.5);
    Column.setWidth(sheet, 4, 8);

    const worksheet = Workbook.getWorksheets(await roundTrip(source))[0]!;
    expect(Column.getWidth(worksheet, 1)).toBe(22.5);
    expect(Column.getWidth(worksheet, 2)).toBe(22.5);
    // The gap stays a gap: a column with no width must not acquire one.
    expect(Column.getWidth(worksheet, 3)).toBeUndefined();
    expect(Column.getWidth(worksheet, 4)).toBe(8);
  });

  it("stores the width in 1/256ths of a character", async () => {
    // The unit that identified the field: 2742 is 10.71 characters, the default Calibri 11 width.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Units");
    Cell.setValue(sheet, "A1", 1);
    Column.setWidth(sheet, 1, 10.71);

    // 10.71 × 256 = 2741.76, which rounds to 2742.
    expect(await sheetListing(source)).toMatch(/BrtColInfo colFirst=0 colLast=0 width=2742/);
  });

  it("emits no column collection when no width was set", async () => {
    // Writing the default would pin it as though the author had chosen it.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 1);
    expect(await sheetListing(source)).not.toContain("ColInfo");
  });

  it("writes the column collection before the cell data", async () => {
    // A consumer sizes its columns before it has rows to put in them.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Ordered");
    Cell.setValue(sheet, "A1", 1);
    Column.setWidth(sheet, 1, 12);

    const listing = await sheetListing(source);
    expect(listing.indexOf("BrtBeginColInfos")).toBeLessThan(listing.indexOf("BrtBeginSheetData"));
  });
});

describe("row heights", () => {
  it("round-trips a height in points", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Tall");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", 2);
    Row.setHeight(sheet, 1, 33);

    const worksheet = Workbook.getWorksheets(await roundTrip(source))[0]!;
    expect(Row.getHeight(worksheet, 1)).toBe(33);
    // A row that never had a height set must not acquire the default as an explicit one.
    expect(Row.getHeight(worksheet, 2)).toBeUndefined();
  });

  it("stores the height in twips", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Twips");
    Cell.setValue(sheet, "A1", 1);
    Row.setHeight(sheet, 1, 24);

    // 24pt × 20 = 480, and `flags` is now the *second* flag byte — `fUnsynced` at bit 5, so 32. It read 2
    // while the record's two flag bytes were declared as one `u16`, which put the flag in `fExtraDsc`.
    expect(await sheetListing(source)).toMatch(
      /BrtRowHdr rw=0 ixfe=0 miyRw=480 ascDsc=0 flags=32 phShow=0/
    );
  });

  it("marks a custom height so Excel keeps it", async () => {
    // Without `fUnsynced` a written height is advisory and recomputed from the font, and the
    // flag is also what tells the reader a height was chosen rather than defaulted.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Flagged");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", 2);
    Row.setHeight(sheet, 2, 40);

    const listing = await sheetListing(source);
    expect(listing).toMatch(/BrtRowHdr rw=0 ixfe=0 miyRw=300 ascDsc=0 flags=0 phShow=0/);
    // `fUnsynced` is bit 5 of the byte at offset 11, which is 32 — not 2 in the byte before it.
    expect(listing).toMatch(/BrtRowHdr rw=1 ixfe=0 miyRw=800 ascDsc=0 flags=32 phShow=0/);
  });
});

describe("everything together", () => {
  it("carries the whole set through one round trip", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Report");
    Worksheet.addAoa(sheet, [
      ["Region", "Revenue"],
      ["North", 1250.5]
    ]);
    Cell.setStyle(sheet, "B2", { numFmt: "#,##0.00" });
    Cell.setValue(sheet, "C2", { formula: "B2*1.2", result: 1500.6 });
    Worksheet.merge(sheet, "A4:C4");
    Cell.setValue(sheet, "A4", "footer");
    Column.setWidth(sheet, 1, 18);
    Row.setHeight(sheet, 1, 28);
    Workbook.addWorksheet(source, "Notes", { state: "hidden" });

    const reopened = await roundTrip(source);
    const worksheet = Workbook.getWorksheets(reopened)[0]!;

    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
    expect(Cell.getStyle(worksheet, "B2")?.numFmt).toBe("#,##0.00");
    expect(Worksheet.getModel(worksheet).mergeCells).toEqual(["A4:C4"]);
    expect(Column.getWidth(worksheet, 1)).toBe(18);
    expect(Row.getHeight(worksheet, 1)).toBe(28);
    expect(Worksheet.getModel(Workbook.getWorksheets(reopened)[1]!).state).toBe("hidden");
  });
});

describe("content this writer cannot express is named, not dropped", () => {
  /**
   * `unsupportedKind` already reported seven shapes. Three more reached the file silently, and
   * each was silent in a way a round trip confirms as correct:
   *
   * - An array formula written as an ordinary formula computes one value where the author asked
   *   for a range, and reads back as that one value.
   * - A shared-string cell's value is an *index*; through the numeric path it becomes a small
   *   integer that looks like data.
   * - A merge reference `BrtMergeCell` cannot express comes back as no merge at all.
   *
   * A shared formula was already reported, so the array case was the same situation left out.
   */
  /**
   * **An array formula is written now, not reported.** This asserted the refusal, and the refusal existed
   * because `BrtArrFmla`'s layout was undetermined against the nine-workbook corpus the claim was written
   * for. The current corpus settles it — `poi-bug66682.xlsb` carries one and the field list closes to the
   * byte — so the record is emitted and the assertion is now about the bytes rather than the excuse.
   *
   * A `shareType` with no `ref` is still refused, and that is a different thing: the range is the one fact
   * the record exists to state, and narrowing it to a single cell would silently shrink an author's spill.
   */
  it("writes an array formula as BrtArrFmla over its range", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", {
      formula: "SUM(A2:A3)",
      result: 1,
      shareType: "array",
      ref: "A1:B2"
    } as never);
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    // The cell, then the record carrying the expression its `PtgExp` defers to.
    expect(listing).toMatch(/BrtFmlaNum[\s\S]*BrtArrFmla/);
  });

  it("still refuses a share type with no range", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", {
      formula: "SUM(A2:A3)",
      result: 1,
      shareType: "array"
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /S1!A1: array formula without a range/
    );
  });

  it("reports a dynamic array formula", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", {
      formula: "A2:A4",
      result: 1,
      isDynamicArray: true
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /S1!A1: dynamic array formula/
    );
  });

  /**
   * What `unsupported: "ignore"` actually writes, which is the half the tests above never looked at.
   *
   * Both cases were reported correctly and then written anyway: the report is produced by the model
   * adapter, and the adapter went on to pass the formula down to the cell encoder regardless. So the
   * documented outcome — "write them as blanks instead" — was not what happened, and asserting only
   * the rejection could not see it. An array formula reached the file as an *ordinary* formula, which
   * is a different formula: it computes one value where the author asked for a spilled range.
   */
  it.each([
    ["array formula with no range", { formula: "SUM(A2:A3)", result: 1, shareType: "array" }],
    ["dynamic array", { formula: "A2:A4", result: 1, isDynamicArray: true }]
  ])("writes an ignored %s as a blank, not as a formula", async (_kind, value) => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", value as never);
    const entries = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    expect(listing).toContain("BrtCellBlank");
    expect(listing).not.toMatch(/BrtFmla/);
  });

  /**
   * A formula whose cached result is an error.
   *
   * The formula is kept, and that is deliberate rather than an oversight left in place: Excel
   * recalculates on open, so the cell displays its error correctly, while blanking it would lose the
   * expression permanently in order to protect a value that is about to be recomputed. What was wrong
   * was the silence — the cached error became a plain `0` with nothing said, and this library's own
   * reader is exactly the kind of consumer that then reads `0`.
   *
   * Writing `BrtFmlaError` properly is not available: no workbook in the reference corpus contains
   * one, so the error-code byte is unobserved.
   */
  it("writes a formula's cached error as BrtFmlaError, and refuses nothing", async () => {
    // **This case used to pin the defect.** It asserted that a cached `#DIV/0!` was *refused* and written as a
    // `BrtFmlaNum` — so the error came back as the number 0, silently, and the test called that correct. The reasoning
    // it rested on ("no workbook in the reference corpus contains a single `BrtCellError` or `BrtFmlaError`") was true
    // of the nine-file corpus and false of the current twenty-three: `poi-bug66682` and `poi-testVarious` hold five
    // between them, carrying four distinct `BErr` codes. `verify:xlsb-corpus` found it once its fingerprint could see
    // cell values.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", {
      formula: "1/0",
      result: { error: "#DIV/0!" }
    } as never);
    // Nothing to refuse: the record expresses it exactly.
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    const listing = describeBiffStream(
      (await extractAll(bytes)).get("xl/worksheets/sheet1.bin")!.data
    );
    expect(listing).toContain("BrtFmlaError");
    expect(listing).not.toContain("BrtFmlaNum");
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    const sheet = Workbook.getWorksheet(reopened, "S1")!;
    expect(Cell.getFormula(sheet, "A1")).toBe("1/0");
    // The half that was being lost: the cached error itself.
    expect(Cell.getValue(sheet, "A1")).toEqual({ formula: "1/0", result: { error: "#DIV/0!" } });
  });

  it("still reports a cached error that has no BErr code", async () => {
    // The narrowing must not swing the other way. `#SPILL!` postdates the enumeration, so there is no byte for it and
    // substituting one would be a different error rather than a reported loss.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", {
      formula: "SEQUENCE(3)",
      result: { error: "#SPILL!" }
    } as never);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /S1!A1: formula cached error/
    );
  });

  it.each(["A1", "1:2", "A:B"])("reports the merge reference %s it cannot express", reference => {
    // Exercised against the writer's own parser, because the surface rejects some of these
    // before they reach it — and the writer must still not drop the ones that get through.
    //
    // `1:2` and `A:B` are unbounded, which `BrtMergeCell`'s four indices cannot state. `A1` is a single cell, which the
    // shared range parser accepts as a 1×1 rectangle — right for a conditional format, wrong for a merge — so this
    // caller adds the "more than one cell" condition itself.
    const result = mergesFromModel({ mergeCells: [reference] } as never);
    expect(result.ranges).toHaveLength(0);
    expect(result.unsupported).toEqual([`${reference}: merge range`]);
  });

  it.each([
    ["A1:B2", "the ordinary form"],
    ["B2:A1", "inverted, naming the same rectangle"],
    ["$A$1:$B$2", "absolute"]
  ])("accepts %s — %s", reference => {
    // **`B2:A1` used to be refused and `$A$1:$B$2` used to be reported as unsupported.** This path had its own regex,
    // which had no `\$?` and rejected an inverted range outright — while the four other range callers in the same module
    // decoded through a shared helper that passed an inversion straight into an `RfX`, producing exactly the
    // `coordinate-range-inverted` record the refusal here was justified by avoiding. One parser now serves all five.
    const result = mergesFromModel({ mergeCells: [reference] } as never);
    expect(result.unsupported).toEqual([]);
    expect(result.ranges).toEqual([{ firstRow: 0, lastRow: 1, firstColumn: 0, lastColumn: 1 }]);
  });
});

describe("row and column formatting", () => {
  /**
   * `BrtRowHdr` has always carried an `ixfe` and this writer has always written a zero into it,
   * because `SheetRow.styleIndex` was declared and never populated — so `RowModel.style` had no
   * path out of the model at all. `BrtColInfo.ixfe` was the same.
   *
   * No row or column in the reference corpus carries a non-zero index, so the *use* of the field
   * is unobserved; its offset is not, being pinned by `rw` at 0 and `miyRw` at 8 with nowhere else
   * for a `u32` to sit. That distinction is registered in `INFERRED_VALUES`.
   */
  it("round-trips a row style", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A5", 1);
    Row.setStyle(sheet, 5, { font: { bold: true }, numFmt: "0.00%" });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const style = Row.getStyle(Workbook.getWorksheets(reopened)[0]!, 5);
    expect(style?.numFmt).toBe("0.00%");
    expect(style?.font?.bold).toBe(true);
  });

  it("round-trips a column style alongside its width", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "B1", 1);
    Column.setWidth(sheet, 2, 20);
    Column.setStyle(sheet, 2, {
      font: { italic: true },
      alignment: { horizontal: "right" }
    });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    expect(Column.getWidth(read, 2)).toBe(20);
    expect(Column.getStyle(read, 2)).toMatchObject({
      font: { italic: true },
      alignment: { horizontal: "right" }
    });
  });

  it("does not give an unstyled row or column a style", async () => {
    // `BrtRowHdr` carries a zero `ixfe` for a row with no format of its own, and Excel writes a
    // row header for every row that has cells. Treating zero as an index would give every row in
    // every sheet the default format explicitly, which is not the same as having none.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Column.setWidth(sheet, 1, 12);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    expect(Row.getStyle(read, 1)).toEqual({});
    expect(Column.getStyle(read, 1)).toEqual({});
  });

  it("shares one cell format between a row style and a cell that matches it", async () => {
    // Rows, columns and cells intern into the same table, so a row and a cell asking for the same
    // formatting must not produce two entries.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { font: { bold: true } });
    Row.setStyle(sheet, 3, { font: { bold: true } });
    Cell.setValue(sheet, "A3", 2);

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/styles.bin")!.data);
    // The default font plus one bold font, however many things reference it.
    expect([...listing.matchAll(/BrtFont/g)]).toHaveLength(2);
  });
});

describe("index zero of each style table", () => {
  it("means the default, even when the file puts something in it", async () => {
    // `BrtRowHdr.ixfe`, `BrtXF.iFont` and the rest are real indices, and Excel writes 0 for
    // "the default". A foreign file may nonetheless carry a *styled* entry at index 0 — nothing
    // forbids it — and then reading 0 as an index would give the bold font to every row and cell
    // that asked for nothing. `readStyles` is the single place that policy lives; this fixture is
    // a file that exercises it.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/xl/styles.bin" ContentType="application/vnd.ms-excel.styles"/>' +
        "</Types>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtRowHdr", rowHeader({ row: 0 })],
        ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    // One font — bold — and a single cell format at index 0 pointing at it.
    archive.add(
      "xl/styles.bin",
      biff([
        ["BrtBeginStyleSheet"],
        ["BrtBeginFonts", new Uint8Array([1, 0, 0, 0])],
        ["BrtFont", encodeFont({ name: "Calibri", size: 11, bold: true })],
        ["BrtEndFonts"],
        ["BrtBeginCellXFs", new Uint8Array([1, 0, 0, 0])],
        ["BrtXF", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x10, 0, 0])],
        ["BrtEndCellXFs"],
        ["BrtEndStyleSheet"]
      ])
    );

    const workbook = Workbook.create();
    await Workbook.read(workbook, await archive.bytes());
    const sheet = Workbook.getWorksheets(workbook)[0]!;
    // The *cell* is what pins this. Its `BrtXF` names font 0, and font 0 is bold in this file — so
    // a reader that resolved index 0 as an index would report a bold cell. The row is a weaker
    // assertion because the row path skips a zero `ixfe` before `readStyles` is consulted at all.
    expect(Cell.getStyle(sheet, "A1")).toEqual({});
    expect(Row.getStyle(sheet, 1)).toEqual({});
  });
});

describe("a cell's own format wins over its row's", () => {
  it("keeps a cell style set on a cell inside a styled row", async () => {
    // Found by writing an example, which is the only place this shape occurs naturally: a header
    // row styled as a row, plus one cell in it that wants something else.
    //
    // `Row.setStyle` propagates to every cell in the row, so applying the row's format *after* the
    // cells overwrites what each cell declared for itself — inverting the format's own rule, where
    // a cell's `iStyleRef` is what wins over its row's `ixfe`. The symptom is quiet: the rotated
    // cell comes back with the header's alignment and no rotation at all.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Worksheet.addRow(sheet, ["a", "b"]);
    Row.setStyle(sheet, 1, { alignment: { horizontal: "center", vertical: "middle" } });
    Cell.setValue(sheet, "F1", "rotated");
    Cell.setStyle(sheet, "F1", { alignment: { textRotation: 90 } });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;

    expect(Cell.getStyle(read, "F1")?.alignment).toEqual({ textRotation: 90 });
    // The rest of the row still has the row's format.
    expect(Cell.getStyle(read, "A1")?.alignment).toEqual({
      horizontal: "center",
      vertical: "middle"
    });
  });

  it("matches what the XLSX path does with the same workbook", async () => {
    // The strongest available oracle for a question like this: the same model through the other
    // container. A disagreement means one of the two is wrong, which a single-format test cannot
    // tell you.
    const build = (): ReturnType<typeof Workbook.create> => {
      const workbook = Workbook.create();
      const sheet = Workbook.addWorksheet(workbook, "S");
      Worksheet.addRow(sheet, ["a", "b"]);
      Row.setStyle(sheet, 1, { font: { bold: true } });
      Cell.setValue(sheet, "C1", "italic");
      Cell.setStyle(sheet, "C1", { font: { italic: true } });
      return workbook;
    };

    const results: Record<string, unknown> = {};
    for (const format of ["xlsx", "xlsb"] as const) {
      const reopened = Workbook.create();
      await Workbook.read(reopened, await Workbook.toBuffer(build(), { format }));
      const style = Cell.getStyle(Workbook.getWorksheets(reopened)[0]!, "C1");
      results[format] = { italic: style?.font?.italic, bold: style?.font?.bold };
    }
    expect(results.xlsb).toEqual(results.xlsx);
  });

  it("keeps a row height set alongside a row style", async () => {
    // Setting a row's format resets its height as a side effect, so the height has to be applied
    // after — which is the opposite of the ordering the cells need.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A3", 1);
    Row.setStyle(sheet, 3, { font: { bold: true } });
    Row.setHeight(sheet, 3, 32);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    expect(Row.getHeight(read, 3)).toBe(32);
    expect(Row.getStyle(read, 3)?.font?.bold).toBe(true);
  });
});
