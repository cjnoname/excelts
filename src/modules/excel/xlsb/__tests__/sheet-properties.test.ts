/**
 * `BrtWsProp` — the sheet's tab colour and VBA code name, against Excel's own bytes.
 *
 * The code name is why this record matters beyond cosmetics. Now that `xl/vbaProject.bin` is
 * preserved verbatim, dropping the code names would produce a workbook whose macros address sheets
 * that no longer answer to those names — a read-modify-write that keeps the code and breaks its
 * bindings.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import {
  HEADER_SIZE,
  encodeSheetProperties,
  readSheetProperties
} from "@excel/xlsb/sheet-properties";
import { describeBiffStream } from "@test/biff-dump";
import { hexBytes, toHex } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

/** Verbatim from the corpus, at all three lengths it contains. */
const NO_CODE_NAME = "c9 04 02 00 40 00 00 00 00 00 00 ff ff ff ff ff ff ff ff 00 00 00 00";
const CYRILLIC =
  "c9 04 02 00 40 00 00 00 00 00 00 ff ff ff ff ff ff ff ff 05 00 00 00 " +
  "1b 04 38 04 41 04 42 04 31 00";
const SHEET1 =
  "c9 04 02 00 40 00 00 00 00 00 00 ff ff ff ff ff ff ff ff 06 00 00 00 " +
  "53 00 68 00 65 00 65 00 74 00 31 00";

describe("BrtWsProp against Excel's own bytes", () => {
  it("self-checks at every length the corpus contains", () => {
    // The record ends in an XLWideString, so `23 + 2 × cch` must equal the payload length. It does
    // at 23, 33 and 35 bytes, which is what fixes the header at 23 rather than leaving it assumed.
    for (const payload of [NO_CODE_NAME, CYRILLIC, SHEET1]) {
      const raw = hexBytes(payload);
      const cch = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(
        HEADER_SIZE,
        true
      );
      expect(HEADER_SIZE + 4 + cch * 2, payload).toBe(raw.length);
    }
  });

  it("reads a sheet with no tab colour and no code name as having neither", () => {
    // `00 40 …` is a `BrtColor` with `fValidRGB` clear and index 64: the automatic colour. Every
    // sheet in the corpus is this, so an automatic colour is reported as no colour rather than as
    // a colour a caller never chose.
    expect(readSheetProperties(hexBytes(NO_CODE_NAME), "sheet")).toBeUndefined();
  });

  it("reads the code name, including a non-Latin one", () => {
    expect(readSheetProperties(hexBytes(CYRILLIC), "sheet")).toEqual({ codeName: "Лист1" });
    expect(readSheetProperties(hexBytes(SHEET1), "sheet")).toEqual({ codeName: "Sheet1" });
  });

  it("reproduces all three byte for byte", () => {
    for (const payload of [NO_CODE_NAME, CYRILLIC, SHEET1]) {
      expect(toHex(encodeSheetProperties(readSheetProperties(hexBytes(payload), "sheet")))).toBe(
        payload.replace(/\s+/g, " ")
      );
    }
  });

  it("spells an absent tab colour the way a sheet does, not the way a font does", () => {
    // A `BrtFont`'s automatic colour has `fValidRGB` set (`01 40 …`); a `BrtWsProp`'s tab colour has
    // it clear (`00 40 …`). Both hold across the whole corpus, so this is a per-record convention
    // rather than a field misread — and only a byte-for-byte comparison surfaces it.
    expect(toHex(encodeSheetProperties(undefined)).startsWith("c9 04 02 00 40")).toBe(true);
  });
});

describe("tab colour and code name reach the sheets that asked for them", () => {
  it("round-trips both", async () => {
    const source = Workbook.create();
    const alpha = Workbook.addWorksheet(source, "Alpha");
    Cell.setValue(alpha, "A1", 1);
    alpha.properties = {
      ...alpha.properties,
      tabColor: { argb: "FFFF0000" },
      codeName: "SheetAlpha"
    };
    const beta = Workbook.addWorksheet(source, "Beta");
    Cell.setValue(beta, "A1", 2);
    beta.properties = { ...beta.properties, tabColor: { theme: 4 } };

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const [readAlpha, readBeta] = Workbook.getWorksheets(reopened);
    expect(readAlpha!.properties.tabColor).toEqual({ argb: "FFFF0000" });
    expect(readAlpha!.properties.codeName).toBe("SheetAlpha");
    expect(readBeta!.properties.tabColor).toEqual({ theme: 4 });
    expect(readBeta!.properties.codeName).toBeUndefined();
  });

  it("writes BrtWsProp for every sheet, with neither field set when there is nothing to set", async () => {
    // Excel writes it unconditionally — a sheet with no tab colour still has properties — and
    // omitting it left the sheet short of a record a consumer expects. The bytes for "nothing set"
    // are the ones every corpus sheet carries.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Plain"), "A1", 1);
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    expect(listing).toContain("BrtWsProp");

    // And it still reports no tab colour and no code name on the way back.
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const properties = Workbook.getWorksheets(reopened)[0]!.properties;
    expect(properties.codeName).toBeUndefined();
    // An automatic tab colour is the absence of a choice, so nothing is reported for it — the
    // model's own default for a fresh sheet is likewise absent, not an empty object.
    expect(properties.tabColor).toBeUndefined();
  });
});
