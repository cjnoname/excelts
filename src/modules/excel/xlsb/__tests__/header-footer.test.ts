/**
 * `BrtBeginHeaderFooter`, against Excel's own bytes.
 *
 * The layout self-checks — a `u16` of flags then six `XLNullableWideString`s consumes exactly the
 * payload at both lengths the corpus contains — and the contents confirm it a second way: one sample
 * carries a font style spelled in Russian, in precisely the workbook whose style name is Russian.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { encodeHeaderFooter, hasHeaderFooter, readHeaderFooter } from "@excel/xlsb/header-footer";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describeBiffStream } from "@test/biff-dump";
import { describe, expect, it } from "vitest";

/** Verbatim from `issue127.xlsb`: centred sheet name, centred page number. */
const SHORT = (() => {
  const wide = (text: string): number[] => {
    const bytes = [text.length, 0, 0, 0];
    for (const character of text) {
      const code = character.charCodeAt(0);
      bytes.push(code & 0xff, code >> 8);
    }
    return bytes;
  };
  const absent = [0xff, 0xff, 0xff, 0xff];
  return new Uint8Array([
    0x0c,
    0x00,
    ...wide("&C&A"),
    ...wide("&CPage &P"),
    ...absent,
    ...absent,
    ...absent,
    ...absent
  ]);
})();

describe("BrtBeginHeaderFooter against Excel's own bytes", () => {
  it("reads the codes a sheet prints", () => {
    expect(readHeaderFooter(SHORT, "sheet")).toEqual({
      oddHeader: "&C&A",
      oddFooter: "&CPage &P"
    });
  });

  it("reproduces them byte for byte", () => {
    const model = readHeaderFooter(SHORT, "sheet");
    expect([...encodeHeaderFooter(model)]).toEqual([...SHORT]);
    // 2 + 6 × 4 for the counts, plus the two strings: the arithmetic is what pins the field count.
    expect(SHORT).toHaveLength(2 + 6 * 4 + ("&C&A".length + "&CPage &P".length) * 2);
  });

  it("distinguishes an absent string from an empty one on the way in and collapses them on the way out", () => {
    // The record has two spellings and a reader has one meaning: nothing is printed there. Reporting
    // `""` would add a field the author never set.
    const model = readHeaderFooter(SHORT, "sheet");
    expect(model).not.toHaveProperty("evenHeader");
    expect(model).not.toHaveProperty("firstFooter");
  });

  it("passes the formatting codes through unaltered", () => {
    // `&C`, `&P`, `&"font,style"`, `&12` are a miniature language neither container interprets, so a
    // parser here would be a second opinion about a syntax nothing reads.
    const codes = '&L&"Arial,Bold"&14Report&C&D&R&P / &N';
    const model = readHeaderFooter(encodeHeaderFooter({ oddHeader: codes }), "sheet");
    expect(model?.oddHeader).toBe(codes);
  });

  it("keeps a non-Latin font style intact", () => {
    // `date.xlsb` carries exactly this shape, and it is what confirms the offset independently: a
    // string that tracks the document's language is not at the wrong place.
    const codes = '&C&"Times New Roman,Обычный"&12&A';
    expect(readHeaderFooter(encodeHeaderFooter({ oddHeader: codes }), "sheet")?.oddHeader).toBe(
      codes
    );
  });

  it("sets the flags that make the later strings meaningful", () => {
    // A sheet carrying an even-page header with the flag clear prints the odd-page one on every page,
    // so the flag is the difference between "used" and "ignored".
    const evenOnly = readHeaderFooter(
      encodeHeaderFooter({ oddHeader: "&CA", evenHeader: "&CB" }),
      "sheet"
    );
    expect(evenOnly?.differentOddEven).toBe(true);
    expect(evenOnly?.differentFirst).toBeUndefined();

    const firstOnly = readHeaderFooter(
      encodeHeaderFooter({ oddHeader: "&CA", firstHeader: "&CB" }),
      "sheet"
    );
    expect(firstOnly?.differentFirst).toBe(true);
    expect(firstOnly?.differentOddEven).toBeUndefined();
  });

  it("knows when there is nothing to write a record for", () => {
    expect(hasHeaderFooter(undefined)).toBe(false);
    expect(hasHeaderFooter({})).toBe(false);
    expect(hasHeaderFooter({ oddHeader: "" })).toBe(false);
    expect(hasHeaderFooter({ oddHeader: "&CA" })).toBe(true);
  });
});

describe("header and footer reach the sheets that asked for them", () => {
  it("round-trips every position", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Printed");
    Cell.setValue(sheet, "A1", 1);
    const headerFooter = {
      oddHeader: '&L&"Arial,Bold"&14Quarterly Report&R&D',
      oddFooter: "&LConfidential&C&P / &N&R&F",
      evenHeader: "&CEven pages differ",
      evenFooter: "&CEven footer",
      firstHeader: "&CFirst page differs",
      firstFooter: "&CFirst footer"
    };
    sheet.headerFooter = { ...sheet.headerFooter, ...headerFooter };

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(Workbook.getWorksheets(reopened)[0]!.headerFooter).toMatchObject(headerFooter);
  });

  it("writes no record for a sheet that prints nothing", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Bare"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data)).not.toContain(
      "BrtBeginHeaderFooter"
    );
  });

  it("puts the record where Excel puts it", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Printed");
    Cell.setValue(sheet, "A1", 1);
    sheet.headerFooter = { ...sheet.headerFooter, oddHeader: "&C&A" };
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    // Compared as a sequence of record names rather than by searching the dump text: `BrtEndSheetData`
    // contains `BrtEndSheet` as a substring, so `indexOf` on the listing finds the wrong one and the
    // assertion reads backwards — which is how this test first failed against correct output.
    const order: string[] = [];
    for (const record of iterateBiffRecords(entries.get("xl/worksheets/sheet1.bin")!.data, "s")) {
      const name = recordSpec(record.id)?.name;
      if (name !== undefined) {
        order.push(name);
      }
    }
    // After the page setup, before the sheet closes — the order `date.xlsb` uses.
    expect(order.indexOf("BrtBeginHeaderFooter")).toBeGreaterThan(order.indexOf("BrtPageSetup"));
    expect(order.indexOf("BrtEndHeaderFooter")).toBeLessThan(order.indexOf("BrtEndSheet"));
    expect(order.at(-1)).toBe("BrtEndSheet");
  });
});
