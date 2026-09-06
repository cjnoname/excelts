/**
 * The tab bar survives `getModel` → `setModel`, and both writers agree about it.
 *
 * **`WorkbookModel.sheets` carried two meanings, and that was the defect.** Two of its three producers mean "the whole
 * tab bar, chartsheets included": the XLSX writer builds it with `sheetsInTabOrder`, and the XLSX reader assigns the
 * parsed `<sheets>` list. `getWorkbookModel` meant something else — a second copy of `worksheets`, chartsheets absent —
 * while `setWorkbookModel` reads it under the first meaning to restore each sheet's `orderNo`.
 *
 * So a model round trip moved every chartsheet to the end of the tab bar, and left two sheets sharing an `orderNo` so
 * that what came out depended on sort stability rather than on the author's layout. `getModel` and `setModel` are public.
 *
 * The assertions read the **package**, not the model, because the model is what was wrong: a check that compared
 * `getModel(a)` with `getModel(b)` would have agreed with itself while both containers wrote the wrong tab bar.
 */
import { extractAll } from "@archive/unzip/extract";
import { Workbook, Worksheet } from "@excel";
import { readWorkbookPart } from "@excel/xlsb/read/parts";
import { describe, expect, it } from "vitest";

/** Worksheet `A`, chartsheet `C`, worksheet `B` — the interleaving neither array can express alone. */
function interleaved(): Workbook.Handle {
  const workbook = Workbook.create();
  Worksheet.addAoa(Workbook.addWorksheet(workbook, "A"), [["x", 1]]);
  Workbook.addChartsheet(workbook, "C", {
    chart: {
      type: "bar",
      series: [{ name: "S", categories: "A!$A$1:$A$1", values: "A!$B$1:$B$1" }]
    }
  } as never);
  Workbook.addWorksheet(workbook, "B");
  return workbook;
}

/** The same workbook after a public model round trip. */
function throughModel(): Workbook.Handle {
  const clone = Workbook.create();
  Workbook.setModel(clone, Workbook.getModel(interleaved()));
  return clone;
}

/** Sheet names in the order the package declares them — the tab bar, as a consumer sees it. */
async function tabBar(workbook: Workbook.Handle, format: "xlsx" | "xlsb"): Promise<string[]> {
  const bytes =
    format === "xlsx"
      ? await Workbook.toBuffer(workbook, { format: "xlsx", validate: false })
      : await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
  const parts = await extractAll(bytes);
  if (format === "xlsx") {
    const path = [...parts.keys()].find(name => /xl\/workbook\.xml$/.test(name))!;
    const xml = new TextDecoder().decode(parts.get(path)!.data);
    return [...xml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(match => match[1]!);
  }
  const path = [...parts.keys()].find(name => /xl\/workbook\.bin$/.test(name))!;
  return readWorkbookPart(parts.get(path)!.data, path).sheets.map(sheet => sheet.name);
}

describe("an interleaved tab bar", () => {
  it.each(["xlsx", "xlsb"] as const)("is written as A, C, B in %s", async format => {
    // The baseline. Both writers already agreed here — `core/sheet-order` is why — so this is what the round trip has
    // to reproduce rather than an aspiration.
    expect(await tabBar(interleaved(), format)).toEqual(["A", "C", "B"]);
  });

  it.each(["xlsx", "xlsb"] as const)("survives getModel/setModel in %s", async format => {
    // Was `A, B, C`: the chartsheet moved to the end, in both containers.
    expect(await tabBar(throughModel(), format)).toEqual(["A", "C", "B"]);
  });

  it("puts the whole tab bar in WorkbookModel.sheets", () => {
    // The field's meaning, asserted directly. It held only the worksheets, which is what `setWorkbookModel` then used as
    // the tab-order authority.
    const model = Workbook.getModel(interleaved());
    expect((model.sheets ?? []).map(sheet => (sheet as { name?: string }).name)).toEqual([
      "A",
      "C",
      "B"
    ]);
  });

  it("gives every sheet a distinct orderNo after a round trip", () => {
    // The subtler half. `B` and `C` both came back as 1, so the order was decided by sort stability — a workbook that
    // happened to come out right could stop doing so without anything else changing.
    const model = Workbook.getModel(throughModel());
    const orders = [
      ...(model.worksheets ?? []).map(sheet => (sheet as { orderNo?: number }).orderNo),
      ...(model.chartsheets ?? []).map(sheet => (sheet as { orderNo?: number }).orderNo)
    ];
    expect(orders).toHaveLength(3);
    expect(new Set(orders).size).toBe(3);
  });
});
