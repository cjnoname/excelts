import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Stream } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A streamed XLSB has to encode a cross-sheet formula, and has to *say so* when it cannot.
 *
 * Both halves were broken and each hid the other. The streamed sheet writer was given no formula context at all, so
 * `Other!A1` could not resolve its `ixti` and the row encoder wrote a `BrtCellBlank` instead — and the loss it reported
 * was stored on the worksheet in a field nothing read, so `xlsbUnsupported` came back `[]`. Two formulas out of two
 * disappeared from a two-sheet workbook and every check in the repository passed.
 *
 * The context is fetched per sheet rather than captured once, because `addWorksheet` runs between sheet commits: a sheet
 * committed later resolves against more sheets than an earlier one. A reference *forward* — sheet 1 naming sheet 3 —
 * therefore still cannot resolve, which is inherent to writing forward. The test for that case asserts the report, not
 * the absence of one.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-sxf-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cellRecords(path: string, sheet: string): Promise<readonly string[]> {
  const parts = await extractAll(new Uint8Array(await readFile(path)));
  const target = [...parts.keys()].find(name => name.endsWith(`worksheets/${sheet}`));
  expect(target, `${sheet} missing from package`).toBeDefined();
  const out: string[] = [];
  for (const record of iterateInterpretableRecords(parts.get(target!)!.data, "s")) {
    const name = recordSpec(record.id)?.name;
    if (name?.startsWith("BrtFmla") === true || name === "BrtCellBlank" || name === "BrtCellRk") {
      out.push(name);
    }
  }
  return out;
}

describe("streamed XLSB formulas", () => {
  it("encodes a reference to a sheet already committed", async () => {
    const file = join(dir, "back.xlsb");
    const writer = new Stream.WorkbookWriter({ filename: file, format: "xlsb" });
    const other = writer.addWorksheet("Other");
    Stream.setCellValue(other.getCell("A1"), 42);
    other.commit();
    const main = writer.addWorksheet("Main");
    Stream.setCellValue(main.getCell("A1"), { formula: "Other!A1" });
    Stream.setCellValue(main.getCell("B1"), { formula: "SUM(Other!A1:A1)" });
    main.commit();
    await writer.commit();

    // Both are real formula records, not blanks.
    expect(await cellRecords(file, "sheet2.bin")).toEqual(["BrtFmlaNum", "BrtFmlaNum"]);
    expect(writer.xlsbUnsupported).toEqual([]);
  });

  it("reports a forward reference instead of writing a blank cell for it", async () => {
    // The honest limit of writing forward. What must not happen is silence.
    const file = join(dir, "forward.xlsb");
    const writer = new Stream.WorkbookWriter({ filename: file, format: "xlsb" });
    const main = writer.addWorksheet("Main");
    Stream.setCellValue(main.getCell("A1"), { formula: "Later!A1" });
    main.commit();
    const later = writer.addWorksheet("Later");
    Stream.setCellValue(later.getCell("A1"), 7);
    later.commit();
    await writer.commit();

    expect(writer.xlsbUnsupported).toHaveLength(1);
    expect(writer.xlsbUnsupported[0]).toContain("A1");
    expect(writer.xlsbUnsupported[0]).toContain("formula");
  });

  it("surfaces a row-level loss at all", async () => {
    // The field the row encoder writes into had no reader, so this is the assertion that the wiring exists — a report
    // that is computed and discarded reads as a guarantee.
    const file = join(dir, "loss.xlsb");
    const writer = new Stream.WorkbookWriter({ filename: file, format: "xlsb" });
    const main = writer.addWorksheet("Main");
    Stream.setCellValue(main.getCell("A1"), { formula: "Missing!A1" });
    main.commit();
    await writer.commit();
    expect(writer.xlsbUnsupported.length).toBeGreaterThan(0);
  });

  it("keeps a same-sheet formula working", async () => {
    // Guards against a context change breaking the ordinary case.
    const file = join(dir, "local.xlsb");
    const writer = new Stream.WorkbookWriter({ filename: file, format: "xlsb" });
    const sheet = writer.addWorksheet("Only");
    Stream.setCellValue(sheet.getCell("A1"), 2);
    Stream.setCellValue(sheet.getCell("A2"), 3);
    Stream.setCellValue(sheet.getCell("A3"), { formula: "SUM(A1:A2)" });
    sheet.commit();
    await writer.commit();
    expect(await cellRecords(file, "sheet1.bin")).toEqual(["BrtCellRk", "BrtCellRk", "BrtFmlaNum"]);
    expect(writer.xlsbUnsupported).toEqual([]);
  });
});
