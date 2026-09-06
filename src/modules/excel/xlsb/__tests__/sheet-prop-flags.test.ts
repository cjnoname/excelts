import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * Two bits of `BrtWsProp`'s flag word follow from the sheet's content, and both were written as constants.
 *
 * The three flag bytes were copied verbatim from the corpus, with a comment saying so — accurate, and the reason these
 * went unnoticed: no corpus sheet uses fit-to-page and none has an autofilter, so a content-dependent bit looked like a
 * constant. Excel sets each on exactly the one reference workbook that asks for it and on none of the other fourteen,
 * which is what makes the correlation testable rather than assumed.
 *
 * A sheet that asks to be scaled to one page and then writes a flag word saying it does not is inconsistent with
 * itself, and the consumer that notices is the one applying the print settings.
 */
async function flagWord(build: (workbook: Workbook.Handle) => void): Promise<number> {
  const workbook = Workbook.create();
  build(workbook);
  const parts = await extractAll(
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet1\.bin$/.test(name));
  for (const record of iterateInterpretableRecords(parts.get(sheetPath!)!.data, "s")) {
    if (recordSpec(record.id)?.name === "BrtWsProp") {
      return new DataView(
        record.payload.buffer,
        record.payload.byteOffset,
        record.payload.length
      ).getUint32(0, true);
    }
  }
  throw new Error("no BrtWsProp");
}

const FIT_TO_PAGE = 1 << 8;
const FILTER_MODE = 1 << 16;

describe("BrtWsProp content-dependent flags", () => {
  it("sets fFitToPage for a sheet scaled to fit", async () => {
    const flags = await flagWord(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      // No `Worksheet.setPageSetup` in the public surface; the model carries it, and `getModel` returns a copy — so
      // the change has to go back through `setModel`.
      const model = Worksheet.getModel(sheet) as unknown as Record<string, unknown>;
      Worksheet.setModel(sheet, {
        ...model,
        pageSetup: { ...((model["pageSetup"] as Record<string, unknown>) ?? {}), fitToPage: true }
      } as never);
    });
    expect(flags & FIT_TO_PAGE).toBe(FIT_TO_PAGE);
  });

  it("leaves fFitToPage clear otherwise", async () => {
    // The other half: a constant would pass the assertion above and fail this one, which is how the bug survived.
    const flags = await flagWord(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
    });
    expect(flags & FIT_TO_PAGE).toBe(0);
  });

  it("sets fFilterMode for a sheet with an autofilter", async () => {
    const flags = await flagWord(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", "Region");
      Cell.setValue(sheet, "A2", "APAC");
      Worksheet.setAutoFilter(sheet, "A1:A2");
    });
    expect(flags & FILTER_MODE).toBe(FILTER_MODE);
  });

  it("leaves fFilterMode clear otherwise", async () => {
    const flags = await flagWord(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
    });
    expect(flags & FILTER_MODE).toBe(0);
  });

  it("keeps the bits the corpus established", async () => {
    // The rest of the word is still the verbatim value, and the two new bits must not have disturbed it.
    const flags = await flagWord(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
    });
    expect(flags).toBe(0x000204c9);
  });
});
