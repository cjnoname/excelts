/**
 * Page setup, against Excel's own bytes.
 *
 * `BrtMargins` is the most firmly established record in this module and it is worth saying why:
 * `any_sheets.xlsb` carries `0.7, 0.7, 0.75, 0.75, 0.3, 0.3`, which is Excel's default margins
 * exactly. Three pairs of equal values in a record whose defaults are three pairs fixes the field
 * order with no room left for it to be anything else.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import {
  DEFAULT_MARGINS,
  encodeMargins,
  encodePageSetup,
  encodeSheetFormatInfo,
  readMargins,
  readPageSetup,
  readSheetFormatInfo
} from "@excel/xlsb/page-setup";
import { describeBiffStream } from "@test/biff-dump";
import { hexBytes, toHex } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

describe("BrtMargins", () => {
  it("reads Excel's own defaults as Excel's own defaults", () => {
    // Verbatim from `any_sheets.xlsb`. 0.7 inch left and right, 0.75 top and bottom, 0.3 for the
    // header and footer — the values that identified the field order.
    const real =
      "66 66 66 66 66 66 e6 3f 66 66 66 66 66 66 e6 3f " +
      "00 00 00 00 00 00 e8 3f 00 00 00 00 00 00 e8 3f " +
      "33 33 33 33 33 33 d3 3f 33 33 33 33 33 33 d3 3f";
    expect(readMargins(hexBytes(real), "sheet")).toEqual(DEFAULT_MARGINS);
    expect(toHex(encodeMargins(DEFAULT_MARGINS))).toBe(real);
  });

  it("round-trips a metric-locale sheet", () => {
    // `date.xlsb`: 0.7875 inch is 2 cm. The pairing holds in a file whose values are nothing like
    // the defaults, which is what rules out having matched the defaults by luck.
    const margins = {
      left: 0.7875,
      right: 0.7875,
      top: 1.05277777777778,
      bottom: 1.05277777777778,
      header: 0.7875,
      footer: 0.7875
    };
    expect(readMargins(encodeMargins(margins), "sheet")).toEqual(margins);
  });

  it("fills anything the caller omits with Excel's default", () => {
    expect(readMargins(encodeMargins({ left: 2 }), "sheet")).toEqual({
      ...DEFAULT_MARGINS,
      left: 2
    });
  });
});

describe("BrtPageSetup", () => {
  it("reads A4 and 100% out of Excel's own record", () => {
    // Verbatim from `date.xlsb`. Paper size 9 is A4 and the second field is a scale percentage,
    // which is what identified both. The 0x0080 flag says the orientation was chosen.
    const real =
      "09 00 00 00 64 00 00 00 2c 01 00 00 2c 01 00 00 " +
      "01 00 00 00 01 00 00 00 01 00 00 00 01 00 00 00 80 00 ff ff ff ff";
    expect(readPageSetup(hexBytes(real), "sheet")).toEqual({
      paperSize: 9,
      horizontalDpi: 300,
      verticalDpi: 300,
      orientation: "portrait"
    });
    expect(toHex(encodePageSetup(readPageSetup(hexBytes(real), "sheet")))).toBe(real);
  });

  it("does not report an orientation the file left to the printer", () => {
    // `issue127.xlsb` is the same record with the flag clear. Reporting `portrait` there would
    // invent a choice the author did not make.
    const real =
      "09 00 00 00 64 00 00 00 2c 01 00 00 2c 01 00 00 " +
      "01 00 00 00 01 00 00 00 01 00 00 00 01 00 00 00 00 00 ff ff ff ff";
    expect(readPageSetup(hexBytes(real), "sheet")).toEqual({
      paperSize: 9,
      horizontalDpi: 300,
      verticalDpi: 300
    });
  });

  it("writes the printer-settings relationship as absent", () => {
    // `issues.xlsb` carries `"rId2"` here, pointing at `xl/printerSettings/printerSettings1.bin`.
    // This library writes no such part, so naming one would be the same dangling reference as a
    // `PtgName` with no `BrtName`.
    expect(toHex(encodePageSetup({ paperSize: 9 })).endsWith("ff ff ff ff")).toBe(true);
  });
});

describe("BrtWsFmtInfo", () => {
  it("reads 300 twips as 15 points, which is Excel's default row height", () => {
    // Verbatim from `any_sheets.xlsb`. `dxGCol` is 0xFFFFFFFF — unset — so the width comes from
    // the character count.
    const real = "ff ff ff ff 08 00 2c 01 00 00 00 00";
    expect(readSheetFormatInfo(hexBytes(real), "sheet")).toEqual({
      defaultRowHeight: 15,
      defaultColWidth: 8
    });
    expect(toHex(encodeSheetFormatInfo({ defaultRowHeight: 15, defaultColWidth: 8 }))).toBe(real);
  });

  it("prefers dxGCol, which carries a width the character count cannot", () => {
    // `date.xlsb` carries 2958 in `dxGCol` — 11.55 characters in the same 1/256 units `BrtColInfo`
    // uses — alongside a `cchDefColWidth` of 8. Reading only the rounded field would report a
    // width the file does not have.
    const real = "8e 0b 00 00 08 00 08 01 00 00 00 00";
    const info = readSheetFormatInfo(hexBytes(real), "sheet");
    expect(info?.defaultColWidth).toBeCloseTo(11.5546875, 6);
    expect(info?.defaultRowHeight).toBeCloseTo(13.2, 6);
    expect(toHex(encodeSheetFormatInfo(info))).toBe(real);
  });
});

describe("page setup reaches the sheets that asked for it", () => {
  it("round-trips paper, scale, orientation, dpi, margins and defaults", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "P");
    Cell.setValue(sheet, "A1", 1);
    sheet.pageSetup = {
      ...sheet.pageSetup,
      paperSize: 9,
      scale: 80,
      orientation: "landscape",
      horizontalDpi: 600,
      verticalDpi: 600,
      firstPageNumber: 3,
      margins: { left: 1, right: 1, top: 1.5, bottom: 1.5, header: 0.5, footer: 0.5 }
    };
    sheet.properties = { ...sheet.properties, defaultRowHeight: 18, defaultColWidth: 12 };

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;

    expect(read.pageSetup).toMatchObject({
      paperSize: 9,
      scale: 80,
      orientation: "landscape",
      horizontalDpi: 600,
      verticalDpi: 600,
      firstPageNumber: 3,
      margins: { left: 1, right: 1, top: 1.5, bottom: 1.5, header: 0.5, footer: 0.5 }
    });
    expect(read.properties.defaultRowHeight).toBe(18);
    expect(read.properties.defaultColWidth).toBe(12);
  });

  it("only turns fit-to-page on when the source had it on", async () => {
    // The record carries `fitToWidth`/`fitToHeight` unconditionally, so the flag has to be
    // derived. Reading it as always-on would rescale every sheet that never asked to be scaled.
    const source = Workbook.create();
    const plain = Workbook.addWorksheet(source, "Plain");
    Cell.setValue(plain, "A1", 1);
    plain.pageSetup = { ...plain.pageSetup, paperSize: 9 };
    const fitted = Workbook.addWorksheet(source, "Fitted");
    Cell.setValue(fitted, "A1", 1);
    fitted.pageSetup = { ...fitted.pageSetup, fitToPage: true, fitToWidth: 2, fitToHeight: 3 };

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const [readPlain, readFitted] = Workbook.getWorksheets(reopened);
    expect(readPlain!.pageSetup.fitToPage).not.toBe(true);
    expect(readFitted!.pageSetup).toMatchObject({
      fitToPage: true,
      fitToWidth: 2,
      fitToHeight: 3
    });
  });

  it("writes the records for every sheet, as Excel does", async () => {
    // All nine reference workbooks carry `BrtMargins` and `BrtWsFmtInfo` on every sheet, so
    // omitting them for a sheet whose setup is all defaults would be less faithful, not more —
    // and the model's own defaults are Excel's defaults, so the bytes come out the same.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Bare"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    expect(listing).toContain("BrtMargins");
    expect(listing).toContain("BrtPageSetup");

    // And a sheet that asked for nothing reads back with Excel's defaults rather than with
    // whatever a zeroed record would have meant.
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(Workbook.getWorksheets(reopened)[0]!.pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });
});
