/**
 * Number formats through XLSB.
 *
 * Scoped to number formats, and the scope is a judgement rather than a shortcut: `iFmt` is what
 * turns `42663` into a date and `0.155` into a percentage, so a reader that skipped it produces
 * numerically correct output that is *wrong on screen*. Fonts and fills change how a workbook
 * looks; a missing number format changes what it appears to say.
 *
 * The format strings and the date detection come from the same helpers the XLSX path uses. That
 * is asserted here rather than assumed, because two readers of the same document disagreeing
 * about which formats mean "date" would make the container the file arrived in observable.
 */

import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import type { Font } from "@excel/types";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { readFont } from "@excel/xlsb/font";
import { recordSpec } from "@excel/xlsb/spec/records";
import { builtinNumberFormat, CellFormatTable, readStyles, writeStyles } from "@excel/xlsb/styles";
import { describeBiffStream } from "@test/biff-dump";
import { describeWorkbook } from "@test/workbook-describe";
import { describe, expect, it } from "vitest";

/** Round-trip a workbook through XLSB and hand back the reopened one. */
async function roundTrip(source: Workbook.Handle): Promise<Workbook.Handle> {
  const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
  await expectValidXlsb(bytes, { includeWarnings: true });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  return reopened;
}

describe("the format table", () => {
  it("reserves index 0 for the default format", () => {
    // A cell with no format must be able to say so without an entry, which is what makes
    // `styleIndex: 0` meaningful in every cell record.
    const table = new CellFormatTable();
    expect(table.intern({ numberFormat: undefined })).toBe(0);
    expect(table.intern({ numberFormat: "General" })).toBe(0);
    expect(table.isEmpty).toBe(true);
  });

  it("interns a format once", () => {
    // Two cells sharing a format must share an index, or the table grows with the sheet.
    const table = new CellFormatTable();
    expect(table.intern({ numberFormat: "0.00%" })).toBe(1);
    expect(table.intern({ numberFormat: "0.00%" })).toBe(1);
    expect(table.intern({ numberFormat: "yyyy-mm-dd" })).toBe(2);
    expect(table.isEmpty).toBe(false);
  });

  it("numbers custom formats above the built-in range", () => {
    // Below 164 the ids belong to the built-ins, so a writer starting at zero would silently
    // redefine `General`.
    const table = new CellFormatTable();
    table.intern({ numberFormat: "yyyy-mm-dd" });
    const listing = describeBiffStream(writeStyles(table));
    // 0xa4 is 164, the first id a custom format may use.
    expect(listing).toMatch(/BrtFmt <a4 00/);
  });

  it("round-trips through the styles part", () => {
    const table = new CellFormatTable();
    table.intern({ numberFormat: "yyyy-mm-dd" });
    table.intern({ numberFormat: "0.0%" });
    const read = readStyles(writeStyles(table), "xl/styles.bin");
    expect(read.numberFormats).toEqual([undefined, "yyyy-mm-dd", "0.0%"]);
  });

  it("resolves a built-in id to the string the XLSX path uses", () => {
    // Format 14 is the one that identified `iFmt`'s offset in a real `styles.bin`.
    expect(builtinNumberFormat(14)).toBe("mm-dd-yy");
    expect(builtinNumberFormat(0)).toBe("General");
    expect(builtinNumberFormat(9)).toBe("0%");
    // A locale-specific entry carries no single string, and guessing one would invent a format
    // the file never specified.
    expect(builtinNumberFormat(30)).toBeUndefined();
    expect(builtinNumberFormat(9999)).toBeUndefined();
  });

  it("reads only the cell formats, not the named-style formats", () => {
    // `BrtXF` appears in two collections and only the ones inside `BrtBeginCellXfs` are what a
    // cell's index refers to. Collecting both shifts every cell's format by one.
    const table = new CellFormatTable();
    table.intern({ numberFormat: "0.0%" });
    const read = readStyles(writeStyles(table), "xl/styles.bin");
    expect(read.numberFormats).toHaveLength(2);
  });
});

describe("formats survive a round trip", () => {
  it("carries a format on a numeric cell", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Fmt");
    Cell.setValue(sheet, "A1", 1234.5);
    Cell.setStyle(sheet, "A1", { numFmt: "#,##0.00" });
    Cell.setValue(sheet, "A2", 0.155);
    Cell.setStyle(sheet, "A2", { numFmt: "0.0%" });

    const reopened = await roundTrip(source);
    const worksheet = Workbook.getWorksheets(reopened)[0]!;
    expect(Cell.getStyle(worksheet, "A1")?.numFmt).toBe("#,##0.00");
    expect(Cell.getStyle(worksheet, "A2")?.numFmt).toBe("0.0%");
  });

  it("leaves an unformatted cell unformatted", async () => {
    // `General` must not become an entry in the format table, or every cell would come back with an
    // explicit format it never asked for. The styles *part* is a different question: it is always
    // written, because every cell record carries a style index and a package whose indices point at
    // a table that is not present is one Excel declines to open.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 42);

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(entries.has("xl/styles.bin")).toBe(true);

    const reopened = await roundTrip(source);
    expect(Cell.getStyle(Workbook.getWorksheets(reopened)[0]!, "A1")?.numFmt).toBeUndefined();
  });

  it("shares one entry between cells with the same format", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Shared");
    for (let row = 1; row <= 50; row++) {
      Cell.setValue(sheet, `A${row}`, row);
      Cell.setStyle(sheet, `A${row}`, { numFmt: "0.00" });
    }

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/styles.bin")!.data);
    expect(listing.match(/BrtFmt /g)).toHaveLength(1);
    expect(listing).toContain("BrtBeginCellXfs count=2");
  });

  it("keeps a format on a cell with no value", async () => {
    // A formatted-but-empty cell is how a template says "put a date here", so the format is
    // information even when the value is absent.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Template");
    Cell.setStyle(sheet, "B2", { numFmt: "yyyy-mm-dd" });
    Cell.setValue(sheet, "A1", 1);

    const reopened = await roundTrip(source);
    expect(Cell.getStyle(Workbook.getWorksheets(reopened)[0]!, "B2")?.numFmt).toBe("yyyy-mm-dd");
  });

  it("carries a format on a formula cell", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Calc");
    Cell.setValue(sheet, "A1", 100);
    Cell.setValue(sheet, "A2", { formula: "A1*1.2", result: 120 });
    Cell.setStyle(sheet, "A2", { numFmt: "#,##0.00" });

    const worksheet = Workbook.getWorksheets(await roundTrip(source))[0]!;
    expect(Cell.getStyle(worksheet, "A2")?.numFmt).toBe("#,##0.00");
    expect(Cell.getValue(worksheet, "A2")).toMatchObject({ formula: "A1*1.2", result: 120 });
  });

  it("accepts a numFmt given as an id/formatCode pair", async () => {
    // `Style.numFmt` is either the code or the `{ id, formatCode }` shape `styles.xml` carries.
    // Only the code is meaningful here — an XLSX numbering id does not survive into BIFF12,
    // where the writer allocates its own.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Pair");
    Cell.setValue(sheet, "A1", 0.5);
    Cell.setStyle(sheet, "A1", { numFmt: { id: 9, formatCode: "0%" } });

    expect(Cell.getStyle(Workbook.getWorksheets(await roundTrip(source))[0]!, "A1")?.numFmt).toBe(
      "0%"
    );
  });
});

describe("dates", () => {
  it("reads a serial number wearing a date format back as a Date", async () => {
    // BIFF12 stores a date as a number and says so only through the format, exactly as XLSX
    // does. Without this a date reads back as `42650`.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Dates");
    const when = new Date(Date.UTC(2016, 9, 7));
    Cell.setValue(sheet, "A1", when);
    Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });

    const value = Cell.getValue(Workbook.getWorksheets(await roundTrip(source))[0]!, "A1");
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe(when.toISOString());
  });

  it("does not turn an ordinary number into a date", async () => {
    // The detection is by format, so a plain number and a number with a numeric format must
    // both stay numbers.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Numbers");
    Cell.setValue(sheet, "A1", 42650);
    Cell.setValue(sheet, "A2", 42650);
    Cell.setStyle(sheet, "A2", { numFmt: "#,##0" });

    const worksheet = Workbook.getWorksheets(await roundTrip(source))[0]!;
    expect(Cell.getValue(worksheet, "A1")).toBe(42650);
    expect(Cell.getValue(worksheet, "A2")).toBe(42650);
  });

  it("recovers a date whose format came from a built-in id", async () => {
    // The path a real Excel file takes: no `BrtFmt`, just `iFmt = 14`.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Builtin");
    Cell.setValue(sheet, "A1", new Date(Date.UTC(2020, 0, 15)));
    Cell.setStyle(sheet, "A1", { numFmt: builtinNumberFormat(14)! });

    const value = Cell.getValue(Workbook.getWorksheets(await roundTrip(source))[0]!, "A1");
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe(new Date(Date.UTC(2020, 0, 15)).toISOString());
  });

  it("describes the same content as the source workbook", async () => {
    // The content-level assertion, which is what a caller actually cares about: a date is a
    // date and a percentage is the number it was.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Mixed");
    Cell.setValue(sheet, "A1", new Date(Date.UTC(2021, 5, 30)));
    Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });
    Cell.setValue(sheet, "B1", 0.42);
    Cell.setStyle(sheet, "B1", { numFmt: "0.0%" });
    Cell.setValue(sheet, "C1", "text");

    expect(describeWorkbook(await roundTrip(source))).toBe(describeWorkbook(source));
  });
});

describe("the 1904 date system", () => {
  /**
   * Excel for Mac used 1904-01-01 as its epoch and workbooks created that way are still in
   * circulation. A reader that ignores the flag reads every date in one exactly 1462 days early —
   * four years, which produces a plausible-looking date rather than an error, so nothing
   * downstream notices.
   *
   * The flag's position was established by comparing two otherwise-identical reference workbooks:
   * the 1900 one carries `20 00 01 00 …` in `BrtWbProp` and the 1904 one `21 00 01 00 …`.
   */
  it("writes the flag and reads dates against the declared epoch", async () => {
    const when = new Date(Date.UTC(2021, 0, 1));

    for (const date1904 of [false, true]) {
      const source = Workbook.create();
      source.properties = { ...source.properties, date1904 };
      const sheet = Workbook.addWorksheet(source, "Dates");
      Cell.setValue(sheet, "A1", when);
      Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });

      const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
      const reopened = Workbook.create();
      await Workbook.read(reopened, bytes);

      expect(reopened.properties.date1904, `date1904: ${date1904}`).toBe(date1904);
      const value = Cell.getValue(Workbook.getWorksheets(reopened)[0]!, "A1");
      expect(value, `date1904: ${date1904}`).toBeInstanceOf(Date);
      // The same instant either way. The serial differs by 1462; the date must not.
      expect((value as Date).toISOString(), `date1904: ${date1904}`).toBe(when.toISOString());
    }
  });

  it("stores a different serial for the two epochs", async () => {
    // The assertion that proves the flag is doing something rather than being ignored on both
    // sides: 1462 days is exactly the offset between the epochs.
    const when = new Date(Date.UTC(2021, 0, 1));
    const serials: number[] = [];

    for (const date1904 of [false, true]) {
      const source = Workbook.create();
      source.properties = { ...source.properties, date1904 };
      const sheet = Workbook.addWorksheet(source, "Dates");
      Cell.setValue(sheet, "A1", when);
      Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });

      const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
      const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
      serials.push(Number(/value=([\d.]+)/.exec(listing)![1]));
    }

    expect(serials[0]! - serials[1]!).toBe(1462);
  });

  it("writes BrtWbProp for either epoch, with the flag clear for 1900", async () => {
    // Excel writes this record into every workbook, so omitting it for the default epoch was not
    // restraint — it was a missing record. What distinguishes the two is bit 0 of the flags, which
    // is exactly how the field was established: `20 00 01 00` against `21 00 01 00`.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/workbook.bin")!.data);
    // The dump decodes the declared layout rather than showing raw bytes, so the flags word is
    // asserted as the number Excel writes: 0x00010020, with bit 0 — the 1904 epoch — clear.
    expect(listing).toContain(`BrtWbProp flags=${0x00010020}`);
  });
});

describe("fonts and fills reach the cells that asked for them", () => {
  /**
   * The codec tests in `font.test.ts` prove this library agrees with Excel about what a `BrtFont`
   * *is*. They say nothing about whether a font a caller sets on a cell ends up in the font table,
   * whether the cell's `BrtXF` points at it, and whether a reader finds its way back — which is
   * three index hops, each of which can be wrong on its own.
   */
  const styled: readonly { address: string; style: Record<string, unknown> }[] = [
    { address: "A1", style: { font: { bold: true } } },
    { address: "A2", style: { font: { italic: true, size: 14 } } },
    { address: "A3", style: { font: { name: "Times New Roman", size: 18, bold: true } } },
    { address: "A4", style: { font: { color: { argb: "FFFF0000" } } } },
    { address: "A5", style: { font: { color: { theme: 4 } } } },
    { address: "A6", style: { font: { underline: "double", strike: true } } },
    {
      address: "A7",
      style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } } }
    },
    { address: "A8", style: { fill: { type: "pattern", pattern: "gray125" } } },
    { address: "A9", style: { font: { bold: true }, numFmt: "0.00%" } },
    { address: "A10", style: { font: { charset: 134, family: 2, scheme: "minor", name: "等线" } } }
  ];

  it("round-trips every attribute a caller set", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Styled");
    for (const { address, style } of styled) {
      Cell.setValue(sheet, address, address);
      Cell.setStyle(sheet, address, style as never);
    }

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;

    for (const { address, style } of styled) {
      // `toMatchObject`, not `toEqual`: a `BrtFont` has no optional fields — it always carries a
      // name, a size and a scheme byte — so a caller who sets only `bold` necessarily reads back
      // Calibri 11 bold, which is what Excel does with such a cell too. The assertion is that
      // nothing the caller set was lost, not that nothing was added.
      expect(Cell.getStyle(read, address), address).toMatchObject(style);
    }
  });

  it("gives two cells with the same font one font record", async () => {
    // The tables are interned separately because a `BrtXF` holds *indices*: two cells sharing a
    // font but differing in number format must share the font entry. Interning the triple as one
    // opaque key would duplicate the font per format, which is the whole reason for three tables.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Shared");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { font: { bold: true }, numFmt: "0.00" });
    Cell.setValue(sheet, "A2", 2);
    Cell.setStyle(sheet, "A2", { font: { bold: true }, numFmt: "0.000" });
    Cell.setValue(sheet, "A3", 3);
    Cell.setStyle(sheet, "A3", { font: { bold: true } });

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/styles.bin")!.data);
    // The default font, plus one bold font shared by three cells across two number formats.
    expect([...listing.matchAll(/BrtFont/g)]).toHaveLength(2);
    expect([...listing.matchAll(/BrtFmt/g)]).toHaveLength(2);
  });

  it("points each cell format at the right font", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Distinct");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { font: { name: "Arial" } });
    Cell.setValue(sheet, "A2", 2);
    Cell.setStyle(sheet, "A2", { font: { name: "Courier New" } });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    // Two distinct fonts. Were the XF pointing at the wrong index, both cells would report one.
    expect(Cell.getStyle(read, "A1")?.font?.name).toBe("Arial");
    expect(Cell.getStyle(read, "A2")?.font?.name).toBe("Courier New");
  });

  it("keeps a fill clear of the two entries Excel writes first", async () => {
    // Every Excel workbook declares `none` and `gray125` before anything else, so a cell fill
    // cannot be index 0 or 1. An off-by-two here renders every filled cell with the wrong fill.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Filled");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", {
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF123456" } }
    });

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/styles.bin")!.data);
    expect([...listing.matchAll(/BrtFill/g)]).toHaveLength(3);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(Cell.getStyle(Workbook.getWorksheets(reopened)[0]!, "A1")?.fill).toEqual({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF123456" }
    });
  });

  it("writes the parts Excel writes even for a workbook that asks for nothing", async () => {
    // The package this library produced for a bare workbook satisfied every rule its own validator
    // knows and Excel rejected it. What was missing was not a wrong field but whole parts and whole
    // records that Excel writes unconditionally — so "what does Excel put in the smallest possible
    // workbook" is now the assertion, rather than "what is the least this library can get away with".
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));

    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "xl/_rels/workbook.bin.rels",
      "xl/workbook.bin",
      "xl/styles.bin",
      "xl/worksheets/sheet1.bin"
    ]) {
      expect(entries.has(part), part).toBe(true);
    }

    const workbook = describeBiffStream(entries.get("xl/workbook.bin")!.data);
    for (const record of ["BrtFileVersion", "BrtWbProp", "BrtBookView", "BrtCalcProp"]) {
      expect(workbook, record).toContain(record);
    }

    const sheet = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    // A worksheet with no view has nowhere to be displayed, which is the one of these whose absence
    // is easiest to reason about.
    for (const record of [
      "BrtWsProp",
      "BrtBeginWsViews",
      "BrtBeginWsView",
      "BrtSel",
      "BrtWsFmtInfo",
      "BrtSheetProtection",
      "BrtPrintOptions",
      "BrtMargins",
      "BrtPageSetup"
    ]) {
      expect(sheet, record).toContain(record);
    }
  });
});

/**
 * The workbook's default font, which every cell that names no font inherits.
 *
 * Found by the loss scanner rather than by a test, and worth recording as a method note: the scan
 * reported `workbook default font` because `writeStyles` hard-coded Calibri 11 at font index 0. The
 * right answer to a loss whose record layout is *already established* is to write it, not to report
 * it — `BrtFont` is fully supported here, so this was a gap in the writer rather than in the format.
 *
 * Asserted on the emitted record rather than through a cell: index 0 is the entry a cell inherits *by
 * naming nothing*, so there is no cell whose style would report it. The first attempt read it back
 * through `Cell.getStyle`, which returns nothing for style index 0 — a test that would have passed for
 * a writer that ignored the default entirely.
 */
describe("the workbook default font", () => {
  /**
   * The first `BrtFont` in a workbook's `styles.bin`.
   *
   * Read off the record rather than through `StyleTable.fonts`, which is indexed by *cell-format*
   * index and reports `undefined` wherever the entry is the default — so it cannot answer "what is the
   * default", which is the only question here.
   */
  async function fontZero(workbook: Workbook.Handle): Promise<Partial<Font> | undefined> {
    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    for (const record of iterateBiffRecords(entries.get("xl/styles.bin")!.data, "styles")) {
      if (recordSpec(record.id)?.name === "BrtFont") {
        return readFont(record.payload, "styles");
      }
    }
    return undefined;
  }

  it("puts the workbook's default at font index 0 instead of Excel's baseline", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", "unstyled");
    // Through the model, because that is the field the writer reads and there is no public setter.
    (source as { _defaultFont?: unknown })._defaultFont = { name: "Arial", size: 10 };
    const font = await fontZero(source);
    expect(font?.name).toBe("Arial");
    expect(font?.size).toBe(10);
  });

  it("keeps the established baseline for the fields a partial default omits", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    // A partial default still has to produce the complete record `BrtFont` requires.
    (source as { _defaultFont?: unknown })._defaultFont = { name: "Verdana" };
    const font = await fontZero(source);
    expect(font?.name).toBe("Verdana");
    expect(font?.size).toBe(11);
  });

  it("is Calibri 11 when the workbook says nothing", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const font = await fontZero(source);
    expect(font?.name).toBe("Calibri");
    expect(font?.size).toBe(11);
  });
});
