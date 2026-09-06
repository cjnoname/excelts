/**
 * Hyperlinks, which are a record and a relationship rather than a value.
 *
 * `BrtHLink` carries a range and a relationship id; the destination URL lives in the sheet's own `.rels`
 * with `TargetMode="External"`. Neither half is useful alone, which is why this was reported as a loss
 * until the relationship side worked — and why the two corpus files that carry one were what confirmed
 * the layout MS-XLSB 2.4.693 states.
 *
 * The measured case for doing this at all: of the record types real workbooks contain and this writer did
 * not emit, `BrtHLink` is one of the few that carries something a *user* put there. Tables, comments,
 * data validation and page breaks appear in none of the twenty-one readable corpus files.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describeBiffStream } from "@test/biff-dump";
import { describe, expect, it } from "vitest";

/** A workbook with two links and one plain cell. */
function linked(): Workbook.Handle {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Links");
  Cell.setValue(sheet, "A1", {
    text: "documonster",
    hyperlink: "https://example.com/docs"
  } as never);
  Cell.setValue(sheet, "B3", { text: "second", hyperlink: "https://example.com/other" } as never);
  Cell.setValue(sheet, "C1", "no link");
  return workbook;
}

describe("hyperlinks through XLSB", () => {
  it("round-trips the destination and the display text", async () => {
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(linked(), { format: "xlsb" }));
    const sheet = Workbook.getWorksheet(reopened, "Links")!;

    expect(Cell.getHyperlink(sheet, "A1")).toBe("https://example.com/docs");
    expect(Cell.getHyperlink(sheet, "B3")).toBe("https://example.com/other");
    expect(Cell.getHyperlink(sheet, "C1")).toBeUndefined();
    // The *text* is the cell's content and the URL is not. Writing the link without it produced a cell
    // labelled with its own address, which reads as working until you look at it.
    expect(Cell.getValue(sheet, "A1")).toMatchObject({ text: "documonster" });
    expect(Cell.getValue(sheet, "B3")).toMatchObject({ text: "second" });
    expect(Cell.getValue(sheet, "C1")).toBe("no link");
  });

  it("declares each destination as an external relationship", async () => {
    const entries = await extractAll(await Workbook.toBuffer(linked(), { format: "xlsb" }));
    const rels = new TextDecoder().decode(entries.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    // The relationship is what makes a hyperlink a hyperlink; `BrtHLink` only names it.
    expect(rels).toContain('Target="https://example.com/docs"');
    expect(rels).toContain('TargetMode="External"');
    const ids = [...rels.matchAll(/Id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts BrtHLink where Excel puts it", async () => {
    // `BrtEndSheetData → BrtSheetProtection → BrtHLink → BrtPrintOptions`, which is the order both
    // corpus files that carry one use.
    const entries = await extractAll(await Workbook.toBuffer(linked(), { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    expect(listing.indexOf("BrtHLink")).toBeGreaterThan(listing.indexOf("BrtSheetProtection"));
    expect(listing.indexOf("BrtHLink")).toBeLessThan(listing.indexOf("BrtPrintOptions"));
  });

  it("writes one record per linked cell and none for the rest", async () => {
    const entries = await extractAll(await Workbook.toBuffer(linked(), { format: "xlsb" }));
    let count = 0;
    for (const record of iterateInterpretableRecords(
      entries.get("xl/worksheets/sheet1.bin")!.data,
      "sheet1.bin"
    )) {
      if (recordSpec(record.id)?.name === "BrtHLink") {
        count++;
        // Verbatim from `poi-hyperlink.xlsb`: `rfx` is 16 bytes, then a `RelID`, then three empty
        // strings — 40 bytes for a four-character id.
        expect(record.payload).toHaveLength(40);
      }
    }
    expect(count).toBe(2);
  });

  it("no longer reports a hyperlink as a loss", async () => {
    // It used to be refused by name. The default write is strict, so this passing *is* the assertion.
    await expectValidXlsb(await Workbook.toBuffer(linked(), { format: "xlsb" }));
  });
});
