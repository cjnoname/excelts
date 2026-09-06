/**
 * `getWorkbookModel` runs on a streaming writer, and the model it produces is one `writeXlsbPackage` accepts.
 *
 * **This is the contract behind `getWorkbookModel(this as never)`, and it had no test.** A `WorkbookWriterBase` is not a
 * `WorkbookData`: measured on a writer with one sheet, 39 of the model's 49 fields come back `undefined`, because a
 * streaming writer genuinely has no pivot tables, chart entries, slicers or preserved parts. That is fine — what is not
 * fine is `getWorkbookModel` *dereferencing* one of them.
 *
 * It did, once. Adding `sheetsInTabOrder(worksheetModels, wb._chartsheets)` read `.length` off a field the writer does
 * not have, and every streamed XLSB commit threw `TypeError: Cannot read properties of undefined`. The whole suite went
 * red at once, which is the only reason it was caught — nothing pinned the path.
 *
 * So this asserts the two things the cast promises and the compiler cannot check: the model can be built, and the XLSB
 * writer accepts it. A future field access that assumes a `WorkbookData` fails here instead of in every streaming test.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cell, Stream, Workbook, Worksheet } from "@excel";
import { getWorkbookModel } from "@excel/core/workbook.browser";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-writer-model-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A streaming writer, optionally with a sheet. Nothing is committed: the model must build at any point. */
function writer(name: string, withSheet: boolean): Stream.WorkbookWriter {
  const instance = new Stream.WorkbookWriter({
    filename: join(dir, `${name}.xlsb`),
    format: "xlsb",
    useStyles: true
  });
  if (withSheet) {
    instance.addWorksheet("S");
  }
  return instance;
}

describe("the model a streaming writer produces", () => {
  it.each([
    ["with no sheets at all", false],
    ["with one sheet", true]
  ])("builds %s", (label, withSheet) => {
    // The bare case matters most: a field access that assumes an array crashes here before any sheet can mask it.
    const model = getWorkbookModel(writer(`build-${String(withSheet)}`, withSheet) as never);
    expect(model).toBeDefined();
    expect(model.worksheets).toBeInstanceOf(Array);
    // `sheets` is the field whose introduction caused the crash — it must be an array, not `undefined`.
    expect(model.sheets).toBeInstanceOf(Array);
  });

  it("produces a model the XLSB writer accepts", async () => {
    // The other half of the cast's promise. `writeXlsbPackage` is what `commit()` hands the model to, so accepting it is
    // the actual requirement — building it is only the first step.
    const model = getWorkbookModel(writer("accepted", true) as never);
    const written = await writeXlsbPackage(model);
    expect(written.bytes.length).toBeGreaterThan(0);
  });

  it("carries the date system a caller set through the options", async () => {
    // `date1904` used to be settable only by assigning an undeclared field, and the two readers of it — the row encoder
    // and the workbook part — consulted different places, so they disagreed by 1,462 days.
    const model = getWorkbookModel(
      new Stream.WorkbookWriter({
        filename: join(dir, "epoch.xlsb"),
        format: "xlsb",
        useStyles: true,
        date1904: true
      }) as never
    );
    expect(model.properties?.date1904).toBe(true);
  });

  it("round-trips a date under either way of setting the epoch", async () => {
    const when = new Date(Date.UTC(2020, 0, 15));
    for (const via of ["option", "property"] as const) {
      const instance = new Stream.WorkbookWriter({
        filename: join(dir, `epoch-${via}.xlsb`),
        format: "xlsb",
        useStyles: true,
        ...(via === "option" ? { date1904: true } : {})
      });
      if (via === "property") {
        instance.properties = { date1904: true };
      }
      const sheet = instance.addWorksheet("S");
      Stream.setCellValue(sheet.getCell("A1"), when);
      Stream.commitRow(sheet.getRow(1));
      sheet.commit();
      await instance.commit();
      const reopened = Workbook.create();
      await Workbook.read(
        reopened,
        Uint8Array.from(await readFile(join(dir, `epoch-${via}.xlsb`)))
      );
      const value = Cell.getValue(Workbook.getWorksheet(reopened, "S")!, "A1");
      expect(value, via).toBeInstanceOf(Date);
      expect((value as Date).toISOString(), via).toBe(when.toISOString());
      expect(Workbook.getWorksheets(reopened).map(s => Worksheet.getName(s))).toEqual(["S"]);
    }
  });
});
