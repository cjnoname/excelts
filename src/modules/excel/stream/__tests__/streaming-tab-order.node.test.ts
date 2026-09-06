/**
 * A streaming worksheet states its own tab position.
 *
 * **`WorksheetData` declares `orderNo: number` — required — and a streaming worksheet never had one.** Its sheets
 * masquerade as `WorksheetData` (the masquerade is deliberate and documented in `WorksheetWriter`), and
 * `getWorksheets` sorts by `a.orderNo - b.orderNo`, so every comparison was `NaN` and `Array.prototype.sort` fell back
 * to whatever the engine does with an inconsistent comparator.
 *
 * The order came out right by accident. `sheetsInTabOrder` falls back to `sheetNo` when `orderNo` is absent, and a
 * streaming sheet derives `sheetNo` from its `id` — so three layers of fallback stood in for the one field that means
 * tab order, and a workbook that happened to be correct could stop being so without anything else changing.
 *
 * The assertions are on the *written package* rather than on the field, because the field is only interesting if it
 * decides the tab bar.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Stream, Workbook, Worksheet } from "@excel";
import { readWorkbookPart } from "@excel/xlsb/read/parts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-stream-order-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Three sheets through the streaming writer, in a deliberate order. */
async function written(format: "xlsx" | "xlsb"): Promise<Uint8Array> {
  const path = join(dir, `order.${format}`);
  const writer = new Stream.WorkbookWriter({ filename: path, format, useStyles: true });
  const sheets = ["Alpha", "Beta", "Gamma"].map(name => writer.addWorksheet(name));
  for (const sheet of sheets) {
    Stream.setCellValue(sheet.getCell("A1"), sheet.name);
    Stream.commitRow(sheet.getRow(1));
    sheet.commit();
  }
  await writer.commit();
  return Uint8Array.from(await readFile(path));
}

/** Sheet names in the order the package declares them. */
async function tabBar(bytes: Uint8Array, format: "xlsx" | "xlsb"): Promise<string[]> {
  const parts = await extractAll(bytes);
  if (format === "xlsx") {
    const path = [...parts.keys()].find(name => /xl\/workbook\.xml$/.test(name))!;
    const xml = new TextDecoder().decode(parts.get(path)!.data);
    return [...xml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(match => match[1]!);
  }
  const path = [...parts.keys()].find(name => /xl\/workbook\.bin$/.test(name))!;
  return readWorkbookPart(parts.get(path)!.data, path).sheets.map(sheet => sheet.name);
}

describe("a streaming writer's tab order", () => {
  it("gives each worksheet a distinct numeric orderNo", () => {
    // The field itself: it was `undefined` on every streaming sheet, so the comparator that reads it produced `NaN`.
    const writer = new Stream.WorkbookWriter({
      filename: join(dir, "field.xlsx"),
      format: "xlsx",
      useStyles: true
    });
    const orders = ["A", "B", "C"].map(
      name => (writer.addWorksheet(name) as { orderNo?: number }).orderNo
    );
    expect(orders.every(value => Number.isInteger(value))).toBe(true);
    expect(new Set(orders).size).toBe(3);
    // Ascending in the order they were added, which is what tab order means for a writer with no chartsheets.
    expect(orders).toEqual([...orders].sort((left, right) => (left ?? 0) - (right ?? 0)));
  });

  it.each(["xlsx", "xlsb"] as const)("writes them in that order in %s", async format => {
    expect(await tabBar(await written(format), format)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it.each(["xlsx", "xlsb"] as const)("reads back in that order from %s", async format => {
    // Through the model as well, since `getWorksheets` is the sort that was running on `NaN`.
    const reopened = Workbook.create();
    await Workbook.read(reopened, await written(format));
    expect(Workbook.getWorksheets(reopened).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Alpha",
      "Beta",
      "Gamma"
    ]);
  });
});
