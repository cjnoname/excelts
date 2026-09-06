import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * A **split** view's active pane is selected at its own `topLeftCell`; a **frozen** view's panes are all at A1.
 *
 * Excel's four sheets in the oracle's `01-panes` settle this: the three frozen ones write `r0c0` for every pane, and the
 * split one writes its own top-left cell for `PNNBOTRIGHT` while its other three panes stay at A1. Computing each pane's
 * first cell from the split is the tidier idea and is not what Excel does.
 *
 * The pane the active cell belongs to is worth stating carefully, because the names run in the opposite order to the
 * numbers: `PANE = { bottomRight: 0, topRight: 1, bottomLeft: 2, topLeft: 3 }`. Excel's record carries `pane = 0`, so it
 * is `bottomRight`; attaching the cell to `topLeft` on the strength of the name puts it on the wrong record and merely
 * moves the difference.
 */
async function selections(
  build: (sheet: Worksheet.Handle) => void
): Promise<readonly { readonly pane: number; readonly row: number; readonly column: number }[]> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Cell.setValue(sheet, "A1", 1);
  build(sheet);
  const parts = await extractAll(
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
  const path = [...parts.keys()].find(name => /worksheets\/sheet1\.bin$/.test(name));
  const out: { pane: number; row: number; column: number }[] = [];
  for (const record of iterateInterpretableRecords(parts.get(path!)!.data, "s")) {
    if (recordSpec(record.id)?.name !== "BrtSel") {
      continue;
    }
    const view = new DataView(
      record.payload.buffer,
      record.payload.byteOffset,
      record.payload.length
    );
    out.push({
      pane: view.getUint32(0, true),
      row: view.getUint32(4, true),
      column: view.getUint32(8, true)
    });
  }
  return out;
}

describe("BrtSel across pane arrangements", () => {
  it("keeps every selection at A1 for a frozen view", async () => {
    const result = await selections(sheet => {
      Worksheet.freeze(sheet, 0, 1);
    });
    expect(result.length).toBeGreaterThan(0);
    for (const selection of result) {
      expect({ row: selection.row, column: selection.column }).toEqual({ row: 0, column: 0 });
    }
  });

  it("selects the top-left cell in the active pane of a split view", async () => {
    const result = await selections(sheet => {
      // `Worksheet.split(ws, x, y)` takes positions and no `topLeftCell`, so the view is set directly — which is also
      // what reading a file produces.
      Worksheet.split(sheet, 2000, 1200);
      const model = Worksheet.getModel(sheet) as unknown as Record<string, unknown>;
      const views = (model["views"] as Record<string, unknown>[]) ?? [];
      Worksheet.setModel(sheet, {
        ...model,
        views: views.map(view => ({ ...view, topLeftCell: "C4" }))
      } as never);
    });
    // `bottomRight` is pane 0 — see the note above.
    const active = result.find(selection => selection.pane === 0);
    expect(active).toBeDefined();
    // C4 is row index 3, column index 2.
    expect({ row: active!.row, column: active!.column }).toEqual({ row: 3, column: 2 });
  });

  it("leaves the other panes of a split view at A1", async () => {
    // Without this the previous test passes for an implementation that puts the cell on every pane.
    const result = await selections(sheet => {
      // `Worksheet.split(ws, x, y)` takes positions and no `topLeftCell`, so the view is set directly — which is also
      // what reading a file produces.
      Worksheet.split(sheet, 2000, 1200);
      const model = Worksheet.getModel(sheet) as unknown as Record<string, unknown>;
      const views = (model["views"] as Record<string, unknown>[]) ?? [];
      Worksheet.setModel(sheet, {
        ...model,
        views: views.map(view => ({ ...view, topLeftCell: "C4" }))
      } as never);
    });
    for (const selection of result.filter(entry => entry.pane !== 0)) {
      expect({ row: selection.row, column: selection.column }).toEqual({ row: 0, column: 0 });
    }
  });
});
