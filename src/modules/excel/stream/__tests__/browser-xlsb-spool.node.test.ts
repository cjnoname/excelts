import { extractAll } from "@archive/unzip/extract";
import { createZip } from "@archive/zip/zip-bytes";
import { rowGetModel } from "@excel/core/row";
import { Cell, Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

/**
 * The browser streaming reader has to know a spooled worksheet's *container*.
 *
 * A worksheet delivered before the workbook or shared strings it depends on is spooled and replayed later. The Node
 * variant recorded whether the spooled bytes were BIFF12 and dispatched on it; the browser variant recorded only the
 * sheet number and always replayed through `_parseWorksheet` — so a legally-ordered XLSB whose sheet comes first had its
 * binary records handed to an XML parser.
 *
 * ZIP entry order is not something a producer promises, which is the whole reason the spooling path exists. The two
 * variants disagreeing about it meant the same file read correctly under Node and not in a browser.
 *
 * Carries `.node` only because it is quicker to run here; nothing in it is Node-specific.
 */
async function build(): Promise<{ natural: Uint8Array; sheetFirst: Uint8Array }> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Cell.setValue(sheet, "A1", "hello");
  Cell.setValue(sheet, "A2", 42);
  Cell.setValue(sheet, "A3", new Date(Date.UTC(2024, 0, 15)));
  const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  const names = [...parts.keys()];
  const sheets = names.filter(name => /worksheets\/sheet\d+\.bin$/.test(name));
  const entry = (name: string): { name: string; data: Uint8Array } => ({
    name,
    data: parts.get(name)!.data
  });
  return {
    natural: await createZip(names.map(entry)),
    // The sheet before everything it depends on, which is what forces the spool.
    sheetFirst: await createZip(
      [...sheets, ...names.filter(name => !sheets.includes(name))].map(entry)
    )
  };
}

async function readValues(bytes: Uint8Array): Promise<readonly unknown[]> {
  const { WorkbookReader } = await import("@excel/stream/workbook-reader.browser");
  const reader = new WorkbookReader(bytes, {
    worksheets: "emit",
    sharedStrings: "cache",
    entries: "ignore"
  } as never);
  const values: unknown[] = [];
  for await (const event of reader.parse() as AsyncIterable<{
    eventType: string;
    value?: unknown;
  }>) {
    if (event.eventType !== "worksheet") {
      continue;
    }
    for await (const row of event.value as AsyncIterable<Parameters<typeof rowGetModel>[0]>) {
      // A row with no cells yields no model, which is not an error — just nothing to collect.
      const model = rowGetModel(row) as { cells?: readonly { value?: unknown }[] } | null;
      for (const cell of model?.cells ?? []) {
        values.push(cell.value);
      }
    }
  }
  return values;
}

describe("browser streaming reader, spooled XLSB worksheet", () => {
  it("reads a naturally-ordered package", async () => {
    const { natural } = await build();
    const values = await readValues(natural);
    expect(values.slice(0, 2)).toEqual(["hello", 42]);
  });

  it("reads the same values when the worksheet comes first in the ZIP", async () => {
    // The spooling path. Before the fix this replayed BIFF12 bytes through the XML parser.
    const { sheetFirst } = await build();
    const values = await readValues(sheetFirst);
    expect(values.slice(0, 2)).toEqual(["hello", 42]);
  });

  it("agrees with itself across both orderings", async () => {
    // The strongest form: entry order must not be observable in the result at all.
    const { natural, sheetFirst } = await build();
    expect(await readValues(sheetFirst)).toEqual(await readValues(natural));
  });
});
