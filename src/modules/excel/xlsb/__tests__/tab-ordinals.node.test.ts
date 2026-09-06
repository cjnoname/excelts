/**
 * Every sheet ordinal in the XLSB writer comes from the tab bar, not from the worksheet array.
 *
 * **`BrtBundleSh` is the tab bar, and three things index into it.** A formula's `ixti` resolves through the
 * extern-sheet table, a `_xlnm.*` print name is scoped by `localSheetId`, and a worksheet's `fSelected` has to agree
 * with `BrtBookView.itabCur`. All three were computed from a sheet's position among the *worksheets*, while the bundle
 * itself was built with `sheetsInTabOrder` — so the two orderings agreed exactly as long as no chartsheet sat before a
 * worksheet, which is the only case anybody had tested.
 *
 * With worksheet `A`, chartsheet `C`, worksheet `B`, all three were wrong at once and every one of them silently:
 *
 * | What                  | Was                                   | Should be           |
 * | --------------------- | ------------------------------------- | ------------------- |
 * | `A!D1 = B!A1`         | read back as `C!A1`                   | `B!A1`              |
 * | `B`'s print area      | `localSheetId` 1 — the chartsheet     | `localSheetId` 2    |
 * | `activeTab: 2`        | no worksheet marked selected          | `B` selected        |
 *
 * A formula pointing at a different sheet is the worst thing this writer can produce, and the package opened cleanly.
 *
 * The fixture is deliberately the smallest one that separates the two orderings: with the chartsheet last — the shape
 * every existing test used — worksheet index and tab position coincide and none of this can fail.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { readWorkbookPart } from "@excel/xlsb/read/parts";
import { recordSpec } from "@excel/xlsb/spec/records";
import { beforeAll, describe, expect, it } from "vitest";

/** `fSelected` in `BrtBeginWsView`'s flag word, confirmed against a two-worksheet workbook with `activeTab: 1`. */
const F_SELECTED = 0x0040;

/**
 * Worksheet `A`, chartsheet `C`, worksheet `B`, with the three things that index the bundle all in play.
 *
 * The chartsheet sits *between* the worksheets deliberately: appended, it takes tab position 2 and a worksheet's index
 * equals its tab position, so none of the cases below can fail. That is the shape every existing test used.
 */
function interleaved(): Workbook.Handle {
  const workbook = Workbook.create();
  const first = Workbook.addWorksheet(workbook, "A");
  Worksheet.addAoa(first, [["x", 1]]);
  Workbook.addChartsheet(workbook, "C", {
    chart: {
      type: "bar",
      series: [{ name: "S", categories: "A!$A$1:$A$1", values: "A!$B$1:$B$1" }]
    }
  } as never);
  const last = Workbook.addWorksheet(workbook, "B");
  Cell.setValue(last, "A1", 99);
  (last as unknown as { pageSetup: { printArea?: string } }).pageSetup.printArea = "A1:B2";
  Cell.setValue(first, "D1", { formula: "B!A1", result: 99 } as never);
  (workbook as unknown as { views: unknown[] }).views = [{ activeTab: 2 }];
  return workbook;
}

let parts: Awaited<ReturnType<typeof extractAll>>;

beforeAll(async () => {
  parts = await extractAll(
    await Workbook.toBuffer(interleaved(), { format: "xlsb", unsupported: "ignore" })
  );
});

/** The parsed workbook part, which is where the bundle and the defined names live. */
function workbookPart(): ReturnType<typeof readWorkbookPart> {
  const path = [...parts.keys()].find(name => /xl\/workbook\.bin$/.test(name))!;
  return readWorkbookPart(parts.get(path)!.data, path);
}

/** `BrtBeginWsView`'s flag word for one worksheet part. */
function viewFlags(sheetFile: string): number | undefined {
  const path = [...parts.keys()].find(name => name.endsWith(`worksheets/${sheetFile}.bin`));
  if (path === undefined) {
    return undefined;
  }
  for (const entry of iterateInterpretableRecords(parts.get(path)!.data, path)) {
    if (recordSpec(entry.id)?.name === "BrtBeginWsView") {
      return new DataView(
        entry.payload.buffer,
        entry.payload.byteOffset,
        entry.payload.length
      ).getUint16(0, true);
    }
  }
  return undefined;
}

describe("a chartsheet between two worksheets", () => {
  it("puts the chartsheet at tab position 1", () => {
    // The premise the three cases below rest on. If this ever stops holding, they would pass without testing anything.
    expect(workbookPart().sheets.map(sheet => sheet.name)).toEqual(["A", "C", "B"]);
  });

  it("resolves a cross-sheet formula to the worksheet, not the chartsheet", async () => {
    // Was `C!A1`. Read back through the model rather than asserted on bytes, because which sheet a consumer ends up
    // looking at is the thing that was wrong.
    const reopened = Workbook.create();
    await Workbook.read(
      reopened,
      await Workbook.toBuffer(interleaved(), { format: "xlsb", unsupported: "ignore" })
    );
    expect(Cell.getFormula(Workbook.getWorksheet(reopened, "A")!, "D1")).toBe("B!A1");
  });

  it("scopes a print area by its bundle ordinal", () => {
    // Was 1, which is the chartsheet — so a worksheet's print area belonged to a sheet with no cells.
    expect(workbookPart().namedRanges).toEqual([
      { name: "_xlnm.Print_Area", ranges: ["B!$A$1:$B$2"], localSheetId: 2 }
    ]);
  });

  it("marks the sheet activeTab names as selected", () => {
    // `itabCur` was 2 while the only worksheet index that could match was 1, so nothing was selected at all.
    expect(((viewFlags("sheet1") ?? 0) & F_SELECTED) !== 0).toBe(false);
    expect(((viewFlags("sheet2") ?? 0) & F_SELECTED) !== 0).toBe(true);
  });

  it("agrees with the workbook's own itabCur", () => {
    const path = [...parts.keys()].find(name => /xl\/workbook\.bin$/.test(name))!;
    let itabCur: number | undefined;
    for (const entry of iterateInterpretableRecords(parts.get(path)!.data, path)) {
      if (recordSpec(entry.id)?.name === "BrtBookView") {
        // `BrtBookView` is 29 bytes: `xWn`, `yWn`, `dxWn`, `dyWn`, `iTabRatio`, `itabFirst`, `itabCur` as `u32`s, then
        // a flag byte. Offset 16 is `iTabRatio` — reading it there returned 500, the default tab ratio, which is the
        // kind of plausible number that makes an offset mistake look like a defect in the writer.
        itabCur = new DataView(
          entry.payload.buffer,
          entry.payload.byteOffset,
          entry.payload.length
        ).getUint32(24, true);
      }
    }
    // Both halves of the same statement: the workbook says tab 2, and tab 2's sheet is the one carrying `fSelected`.
    expect(itabCur).toBe(2);
    expect(workbookPart().sheets[itabCur!]?.name).toBe("B");
  });
});
