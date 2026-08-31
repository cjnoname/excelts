/**
 * XLSB round-trip: model → binary parts → model.
 *
 * This is what the framework was built for, and the three assertions are deliberately
 * different in kind:
 *
 *  1. **The validator accepts the output.** Structural soundness, checked by the same
 *     rules that would catch a package Excel refuses.
 *  2. **The reader recovers the content.** `describeWorkbook` compares what the workbook
 *     *contains*, so a difference in how a row was materialised or whether a default was
 *     written does not fail the test and a lost cell does.
 *  3. **The disassembly says what it should.** Which records were chosen is not an
 *     implementation detail here — it is the difference between a compact file and a
 *     wasteful one, and between a value stored exactly and one stored approximately.
 *
 * Passing all three is not the same as reading Excel's own files, and the last block
 * pins the gap rather than leaving it to be discovered.
 */

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Row, Workbook, Worksheet } from "@excel";
import { expectValidXlsb, expectValidXlsbPart } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { encodeCol } from "@excel/utils/address";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { readXlsbPackage } from "@excel/xlsb/read/package";
import { readSharedStrings, readWorkbookPart, readWorksheetPart } from "@excel/xlsb/read/parts";
import { recordSpec } from "@excel/xlsb/spec/records";
import { CellFormatTable } from "@excel/xlsb/styles";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import { writeWorksheetPart } from "@excel/xlsb/write/worksheet";
import { describeBiffStream } from "@test/biff-dump";
import { biff, rowHeader } from "@test/biff-fixture";
import { describeWorkbook } from "@test/workbook-describe";
import { describe, expect, it } from "vitest";

/** Write a workbook to XLSB and read the cells back, per sheet. */
async function roundTrip(workbook: Workbook.Handle): Promise<{
  bytes: Uint8Array;
  unsupported: readonly string[];
  sheets: { name: string; cells: Map<string, unknown>; unread: ReadonlyMap<string, number> }[];
  disassemble(part: string): string;
}> {
  const written = await writeXlsbPackage(Workbook.getModel(workbook));
  const entries = await extractAll(written.bytes);

  const sharedStringsPart = entries.get("xl/sharedStrings.bin");
  const sharedStrings = sharedStringsPart
    ? readSharedStrings(sharedStringsPart.data, "xl/sharedStrings.bin").texts
    : [];
  const { sheetNames } = readWorkbookPart(entries.get("xl/workbook.bin")!.data, "xl/workbook.bin");

  const sheets = sheetNames.map((name, index) => {
    const path = `xl/worksheets/sheet${index + 1}.bin`;
    const read = readWorksheetPart(entries.get(path)!.data, path, sharedStrings);
    const cells = new Map<string, unknown>();
    for (const cell of read.cells) {
      cells.set(`${encodeCol(cell.column)}${cell.row + 1}`, cell.value);
    }
    return { name, cells, unread: read.unreadRecords };
  });

  return {
    bytes: written.bytes,
    unsupported: written.unsupported,
    sheets,
    disassemble: part => describeBiffStream(entries.get(part)!.data, { context: part })
  };
}

describe("XLSB round-trip", () => {
  it("produces a package the validator accepts", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(sheet, [
      ["Region", "Revenue"],
      ["North", 1250],
      ["South", 980.5]
    ]);

    const { bytes, unsupported } = await roundTrip(workbook);
    await expectValidXlsb(bytes, { includeWarnings: true });
    expect(unsupported).toEqual([]);
  });

  it("recovers strings, numbers, booleans and blanks", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Values");
    Cell.setValue(sheet, "A1", "text");
    Cell.setValue(sheet, "B1", 42);
    Cell.setValue(sheet, "C1", -17.25);
    Cell.setValue(sheet, "D1", true);
    Cell.setValue(sheet, "E1", false);
    Cell.setValue(sheet, "A2", 0);
    Cell.setValue(sheet, "B2", 1 / 3);

    const { sheets } = await roundTrip(workbook);
    expect(sheets[0]!.cells.get("A1")).toBe("text");
    expect(sheets[0]!.cells.get("B1")).toBe(42);
    expect(sheets[0]!.cells.get("C1")).toBe(-17.25);
    expect(sheets[0]!.cells.get("D1")).toBe(true);
    expect(sheets[0]!.cells.get("E1")).toBe(false);
    expect(sheets[0]!.cells.get("A2")).toBe(0);
    expect(sheets[0]!.cells.get("B2")).toBe(1 / 3);
  });

  it("describes the same content after a round-trip", async () => {
    // The content-level assertion. A model comparison would fail on differences no user
    // could observe; a byte comparison cannot answer the question at all.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Data");
    Worksheet.addAoa(sheet, [
      ["Region", "Q1", "Q2"],
      ["North", 1250, 1310.5],
      ["South", 980, 0.1],
      ["East", -42, 1 / 7]
    ]);
    Cell.setValue(sheet, "D1", true);

    const { sheets } = await roundTrip(source);

    const rebuilt = Workbook.create();
    const rebuiltSheet = Workbook.addWorksheet(rebuilt, sheets[0]!.name);
    for (const [address, value] of sheets[0]!.cells) {
      if (value !== null) {
        Cell.setValue(rebuiltSheet, address, value as string | number | boolean);
      }
    }

    expect(describeWorkbook(rebuilt)).toBe(describeWorkbook(source));
  });

  it("round-trips several sheets, keeping their names and order", async () => {
    const workbook = Workbook.create();
    for (const name of ["First", "Second", "Third with spaces"]) {
      Cell.setValue(Workbook.addWorksheet(workbook, name), "A1", name);
    }

    const { sheets } = await roundTrip(workbook);
    expect(sheets.map(sheet => sheet.name)).toEqual(["First", "Second", "Third with spaces"]);
    expect(sheets.map(sheet => sheet.cells.get("A1"))).toEqual([
      "First",
      "Second",
      "Third with spaces"
    ]);
  });

  it("shares repeated strings instead of storing them per cell", async () => {
    // The point of the shared-string table. A writer that interned per occurrence would
    // still round-trip, and would produce a much larger file.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Repeats");
    for (let row = 1; row <= 20; row++) {
      Cell.setValue(sheet, `A${row}`, "same");
    }

    const { disassemble, sheets } = await roundTrip(workbook);
    const sst = disassemble("xl/sharedStrings.bin");
    expect(sst.match(/BrtSSTItem/g)).toHaveLength(1);
    expect(sst).toContain("cstTotal=20 cstUnique=1");
    expect([...sheets[0]!.cells.values()].every(value => value === "same")).toBe(true);
  });

  it("preserves text that exercises the encoding", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Unicode");
    const values = ["héllo", "日本語", "😀 emoji", 'quote "inside"', "tab\there", "  spaced  "];
    values.forEach((value, index) => Cell.setValue(sheet, `A${index + 1}`, value));

    const { sheets, bytes } = await roundTrip(workbook);
    await expectValidXlsb(bytes);
    expect([...sheets[0]!.cells.values()]).toEqual(values);
  });

  it("scales to a sheet with many rows", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Big");
    for (let row = 1; row <= 2000; row++) {
      Cell.setValue(sheet, `A${row}`, row);
      Cell.setValue(sheet, `B${row}`, `row ${row}`);
    }

    const { bytes, sheets } = await roundTrip(workbook);
    await expectValidXlsb(bytes);
    expect(sheets[0]!.cells.size).toBe(4000);
    expect(sheets[0]!.cells.get("A2000")).toBe(2000);
    expect(sheets[0]!.cells.get("B2000")).toBe("row 2000");
  });
});

describe("record choice is deliberate", () => {
  it("stores an exact number as RK and an inexact one as a double", async () => {
    // Not cosmetic: RK is four bytes where a double is eight, and `encodeRk` returning
    // undefined rather than rounding is what keeps the choice safe.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Numbers");
    Cell.setValue(sheet, "A1", 1250);
    Cell.setValue(sheet, "A2", 19.99);
    Cell.setValue(sheet, "A3", 1 / 3);

    const listing = (await roundTrip(workbook)).disassemble("xl/worksheets/sheet1.bin");
    expect(listing).toMatch(/BrtCellRk cell=col=0,style=0 value=1250/);
    expect(listing).toMatch(/BrtCellRk cell=col=0,style=0 value=19\.99/);
    expect(listing).toMatch(/BrtCellReal cell=col=0,style=0 value=0\.3333333333333333/);
  });

  it("never emits a Short variant", async () => {
    // Their encoding has not been established, so the writer does not use them. This is
    // the assertion that keeps a future change honest: emitting one requires first
    // declaring its layout, which requires having established it.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Data");
    Worksheet.addAoa(sheet, [
      ["a", 1, true],
      ["b", 2.5, false]
    ]);

    const listing = (await roundTrip(workbook)).disassemble("xl/worksheets/sheet1.bin");
    expect(listing).not.toMatch(/BrtShort/);
  });

  it("emits rows and cells in ascending order whatever order it was handed them", () => {
    // Asserted against the part writer directly. Going through the workbook model cannot
    // test this: the model already stores rows in a sparse array and hands them over
    // ascending, so the sort would look load-bearing while never being exercised.
    //
    // It is load-bearing for a caller that builds rows itself, and the ordering is not
    // cosmetic — a streaming reader relies on it and the validator rejects its absence.
    const strings = new SharedStringTable();
    const { bytes: part } = writeWorksheetPart({
      // Passed explicitly because a style index is only meaningful against the table that issued it,
      // and the caller is the one that serialises `styles.bin`.
      formats: new CellFormatTable(),
      rows: [
        {
          row: 7,
          cells: [
            { row: 7, column: 3, value: "d" },
            { row: 7, column: 1, value: "b" }
          ]
        },
        { row: 2, cells: [{ row: 2, column: 0, value: "a" }] },
        { row: 9, cells: [] },
        { row: 1, cells: [{ row: 1, column: 2, value: "c" }] }
      ],
      strings
    });

    const listing = describeBiffStream(part, { context: "sheet1.bin" });
    expect([...listing.matchAll(/BrtRowHdr rw=(\d+)/g)].map(match => Number(match[1]))).toEqual([
      1, 2, 7, 9
    ]);
    // Row 7's two cells were handed over as column 3 then column 1.
    const row7 = listing.slice(listing.indexOf("BrtRowHdr rw=7"));
    expect([...row7.matchAll(/cell=col=(\d+)/g)].map(match => Number(match[1]))).toEqual([1, 3]);

    expectValidXlsbPart(part, "xl/worksheets/sheet1.bin", { includeWarnings: true });
  });

  it("declares a used range that covers the cells present", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Range");
    Cell.setValue(sheet, "B2", 1);
    Cell.setValue(sheet, "D5", 2);

    const { bytes, disassemble } = await roundTrip(workbook);
    // The validator's dimension warning is what would catch an under-declaration, so
    // asking for warnings here is the assertion.
    await expectValidXlsb(bytes, { includeWarnings: true });
    expect(disassemble("xl/worksheets/sheet1.bin")).toMatch(/BrtWsDim ref=1:4×1:3/);
  });
});

describe("the limits are pinned, not implied", () => {
  it("writes a formula it can encode, and reports one it cannot", async () => {
    // Formulas are written now, so what remains unsupported is a *specific* construct rather
    // than the whole feature — an array constant needs a token whose payload lives in the
    // record's extra data. The distinction matters to a caller: "formulas do not work" and
    // "this formula uses an array constant" lead to different decisions.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Formulas");
    Cell.setValue(sheet, "A1", 2);
    Cell.setValue(sheet, "A2", { formula: "A1*2", result: 4 });
    Cell.setValue(sheet, "A3", { formula: "MATCH(1,{1,2,3},0)", result: 1 });

    const { unsupported, sheets } = await roundTrip(workbook);
    expect(unsupported).toEqual(["Formulas!A3: formula"]);
    expect(sheets[0]!.cells.get("A1")).toBe(2);
    // The one it could encode round-trips with its cached result.
    expect(sheets[0]!.cells.get("A2")).toBe(4);
    // The one it could not survives as a blank rather than vanishing: that a cell existed is
    // information, and once styles are written it carries formatting too.
    expect(sheets[0]!.cells.has("A3")).toBe(true);
    expect(sheets[0]!.cells.get("A3")).toBeNull();
  });

  it("reports each unwritable feature by name and address", async () => {
    // The report is the contract for what this writer cannot yet do, so it names the feature
    // rather than saying "unsupported".
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Mixed");
    Cell.setValue(sheet, "A1", { error: "#DIV/0!" });
    Cell.setValue(sheet, "A2", { richText: [{ text: "bold", font: { bold: true } }] });
    Cell.setValue(sheet, "A3", { text: "link", hyperlink: "https://example.com" });
    Cell.setValue(sheet, "A4", "plain");

    const { unsupported, sheets } = await roundTrip(workbook);
    expect(unsupported).toEqual([
      "Mixed!A1: error value",
      "Mixed!A2: rich text",
      "Mixed!A3: hyperlink"
    ]);
    expect(sheets[0]!.cells.get("A4")).toBe("plain");
    // Each survives as a blank. This is what makes the `writableValue` guard load-bearing: an
    // error and a rich string hold their content *inside* `value`, so without it the object
    // reaches the record chooser, which emits nothing and the cell disappears.
    for (const address of ["A1", "A2", "A3"]) {
      expect(sheets[0]!.cells.has(address), address).toBe(true);
      expect(sheets[0]!.cells.get(address), address).toBeNull();
    }
  });

  it("counts nothing as unread in a package it wrote itself", async () => {
    // The counter exists for reading Excel's files. Zero here is the assertion that this
    // writer emits nothing it cannot read back.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Data"), "A1", 1);

    const { sheets } = await roundTrip(workbook);
    expect([...sheets[0]!.unread.entries()]).toEqual([]);
  });

  it("counts a cell record it recognises but cannot decode, rather than dropping it", () => {
    // The documented gap, tested rather than described. Excel writes `BrtShort*` cells
    // freely and their encoding has not been established here, so a reader meeting one
    // must report it — a sheet that silently comes back with fewer cells than it has is
    // the worst possible outcome, and is what a reader that skipped them would produce.
    //
    // Built with the fixture DSL, which can express a record whose payload the table does
    // not describe precisely because it refuses to invent one.
    const part = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 1 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
      // Payload bytes are arbitrary: the point is that the reader does not pretend to
      // know what they mean.
      ["BrtShortRk", Uint8Array.of(0x11, 0x22, 0x33, 0x44)],
      ["BrtShortIsst", Uint8Array.of(0x00, 0x00, 0x00, 0x00)],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);

    // Structurally valid: the validator recognises them as cells and applies the ordering
    // rules, which is the other half of being honest about the gap.
    expectValidXlsbPart(part, "xl/worksheets/sheet1.bin", { includeWarnings: true });

    const read = readWorksheetPart(part, "xl/worksheets/sheet1.bin", []);
    expect(read.cells).toHaveLength(1);
    expect(read.cells[0]).toMatchObject({ row: 0, column: 0, value: 7 });
    expect([...read.unreadRecords.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["BrtShortIsst", 1],
      ["BrtShortRk", 1]
    ]);
  });

  it("counts a shared-string reference it cannot resolve as unread, not as blank", () => {
    // An out-of-range index is a broken file, which the validator reports. Here the cell
    // must be counted rather than become an empty string — a cell that quietly turns
    // blank is indistinguishable from one that was blank.
    const part = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 5 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);

    const read = readWorksheetPart(part, "xl/worksheets/sheet1.bin", ["only one"]);
    expect(read.cells).toEqual([]);
    expect(read.unreadRecords.get("BrtCellIsst")).toBe(1);
  });
});

describe("a sheet's part comes from its relationship, not from its position", () => {
  /**
   * The part path used to be computed as `xl/worksheets/sheet${index + 1}.bin`. That is always
   * right for this library's own output — it names its own parts — and wrong for real files:
   * `any_sheets.xlsb` declares four sheets whose fourth is a chartsheet at
   * `xl/chartsheets/sheet1.bin`, so the worksheet numbering has a hole in it.
   *
   * With the chartsheet last, the arithmetic costs only that sheet. With one in the *middle*,
   * every sheet after it reads the previous sheet's data — silent misplacement, not a missing
   * part — which is the shape this fixture has.
   */
  function sheetPart(value: number): Uint8Array {
    return biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      // The RK field is a raw u32; an integer is `(value << 2) | 0x02`.
      ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (value << 2) | 0x02 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
  }

  async function workbookWithChartsheetInTheMiddle(relsXml: string): Promise<Uint8Array> {
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/xl/worksheets/sheet2.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/xl/chartsheets/sheet1.bin" ContentType="application/vnd.ms-excel.chartsheet"/>' +
        "</Types>"
    );
    archive.add("xl/_rels/workbook.bin.rels", relsXml);
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "First" }],
        ["BrtBundleSh", { state: 0, tabId: 2, relId: "rId2", name: "TheChart" }],
        ["BrtBundleSh", { state: 0, tabId: 3, relId: "rId3", name: "Third" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add("xl/worksheets/sheet1.bin", sheetPart(111));
    archive.add("xl/worksheets/sheet2.bin", sheetPart(333));
    // Deliberately shaped like a worksheet. A real chartsheet holds chart records and no cells,
    // so an empty part would let this test pass whether the reader skipped it or not — the
    // guarantee being asserted is that a chartsheet's stream is *never* interpreted as a grid,
    // whatever it contains.
    archive.add("xl/chartsheets/sheet1.bin", sheetPart(999));
    return archive.bytes();
  }

  const RELS =
    '<?xml version="1.0"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.bin"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.bin"/>' +
    "</Relationships>";

  it("puts each sheet's data on the sheet that declared it", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await workbookWithChartsheetInTheMiddle(RELS));
    const sheets = Workbook.getWorksheets(workbook);

    expect(sheets.map(sheet => Worksheet.getName(sheet))).toEqual(["First", "TheChart", "Third"]);
    expect(Cell.getValue(sheets[0]!, "A1")).toBe(111);
    // Positional arithmetic would put 333 here and leave `Third` empty.
    expect(Cell.getValue(sheets[1]!, "A1")).toBeNull();
    expect(Cell.getValue(sheets[2]!, "A1")).toBe(333);
  });

  it("never interprets a chartsheet's records as cells", async () => {
    // The fixture's chartsheet part is shaped exactly like a worksheet and carries 999. A reader
    // that resolved the part correctly but still parsed it as a grid would report that cell;
    // keeping the sheet present means nothing after it shifts position.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await workbookWithChartsheetInTheMiddle(RELS));
    expect(Cell.getValue(Workbook.getWorksheets(workbook)[1]!, "A1")).toBeNull();
  });

  it("falls back to the positional guess when the rels file is unusable", async () => {
    // Better than reading nothing: a package with a broken rels file still yields its sheets in
    // the shape this library's own writer produces.
    const workbook = Workbook.create();
    await Workbook.read(workbook, await workbookWithChartsheetInTheMiddle("<not-relationships/>"));
    const sheets = Workbook.getWorksheets(workbook);
    expect(sheets).toHaveLength(3);
    expect(Cell.getValue(sheets[0]!, "A1")).toBe(111);
  });
});

describe("records this reader has no name for", () => {
  it("counts them instead of passing over them in silence", async () => {
    // The distinction from `unreadRecords` is real: those are records the spec table *names* and
    // the reader cannot decode. These it does not recognise at all, so there is no name to give —
    // only the id, which is what a future spec-table entry would be keyed by. Skipping them in
    // silence made "this file holds something I did not understand" unlearnable, and the
    // reference corpus carries 26 such ids across 187 occurrences.
    //
    // 0x3ffd/0x3ffe are past every id the spec table declares, so they cannot collide with one
    // this library later learns a name for.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
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
        [0x3ffe, new Uint8Array([1, 2, 3])],
        ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (7 << 2) | 0x02 }],
        [0x3ffe, new Uint8Array([4])],
        [0x3ffd, new Uint8Array(0)],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );

    const workbook = Workbook.create();
    const diagnostics = await readXlsbPackage(workbook, await archive.bytes());
    expect([...diagnostics.unknownRecords.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0x3ffd, 1],
      [0x3ffe, 2]
    ]);
    // Framing is unaffected — each record's length prefix is honoured whether or not it has a
    // name — so the cell sitting between two unknown records still reads.
    expect(Cell.getValue(Workbook.getWorksheets(workbook)[0]!, "A1")).toBe(7);
  });
});

describe("the column span in a row header", () => {
  /**
   * `BrtRowHdr` is twenty-five bytes and this writer emitted twelve, so every row it produced was
   * truncated by thirteen — enough on its own for Excel to reject the package. The thirteen are a
   * byte, a count of column spans, and that many `{first, last}` pairs.
   *
   * The length is now pinned by `OBSERVED_PAYLOAD_SIZES`, but the length is not the whole claim: a
   * record can be exactly twenty-five bytes and still say the wrong thing about which columns the
   * row occupies. The reading was confirmed by correlation — a row with two cells in columns 0 and 1
   * carries `ccolspan = 1` and `{0, 1}` in every corpus workbook — so that is what is asserted here.
   */
  function spanOf(payload: Uint8Array): { count: number; first: number; last: number } {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      count: view.getUint32(13, true),
      first: view.getUint32(17, true),
      last: view.getUint32(21, true)
    };
  }

  async function rowHeaders(workbook: ReturnType<typeof Workbook.create>): Promise<Uint8Array[]> {
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const headers: Uint8Array[] = [];
    for (const record of iterateBiffRecords(entries.get("xl/worksheets/sheet1.bin")!.data, "s")) {
      if (recordSpec(record.id)?.name === "BrtRowHdr") {
        headers.push(record.payload);
      }
    }
    return headers;
  }

  it("declares the inclusive column range the row's cells occupy", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    // Row 1: columns A and B. Row 2: column D alone. Row 3: C through F.
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "B1", 2);
    Cell.setValue(sheet, "D2", 3);
    Cell.setValue(sheet, "C3", 4);
    Cell.setValue(sheet, "F3", 5);

    const headers = await rowHeaders(source);
    expect(headers.map(payload => payload.length)).toEqual([25, 25, 25]);
    expect(headers.map(spanOf)).toEqual([
      { count: 1, first: 0, last: 1 },
      { count: 1, first: 3, last: 3 },
      { count: 1, first: 2, last: 5 }
    ]);
  });

  it("declares one span even for a row with no cells", async () => {
    // A row with only a height. The corpus contains no such row — every reference row has cells —
    // so a shorter "no spans" form is unobserved, and writing an unobserved form of a record whose
    // length Excel never varies is the kind of guess this module does not make.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", 1);
    Row.setHeight(sheet, 3, 30);

    const headers = await rowHeaders(source);
    expect(headers.every(payload => payload.length === 25)).toBe(true);
    expect(headers.every(payload => spanOf(payload).count === 1)).toBe(true);
  });
});
