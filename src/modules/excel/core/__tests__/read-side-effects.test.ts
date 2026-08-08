/**
 * Reads must not mutate the workbook.
 *
 * `getCell` / `getRow` / `rowGetCell` / `getColumn` all *create* the thing they
 * are asked for, and `cellCreate` seeds a new cell with
 * `mergeCellStyle(row.style, column.style, {})` — so a materialised "empty" cell in
 * a styled row or column carries a style, gets a `styleId`, and is written out
 * (`xlsx/xform/sheet/cell-xform.ts` only skips a cell when it is both `Null`
 * and unstyled). Even unstyled, `rowGetModel` counts every existing cell record
 * towards the row's `min`/`max`, so `spans` and `<dimension>` widen too.
 *
 * The net effect is that calling a getter changed the bytes the workbook saved
 * to. Every case below is a read, so every case must be a no-op.
 */
import { captureFormulaSnapshot } from "@excel/core/formula-capture";
import { columnValues, getColumn } from "@excel/core/worksheet-core";
import { Anchor, Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

/**
 * Everything about a workbook that a read must leave alone: the saved bytes,
 * plus the counters and container lengths that materialisation inflates but
 * serialisation happens to hide.
 */
async function fingerprint(wb: ReturnType<typeof Workbook.create>) {
  const sheets = Workbook.getWorksheets(wb).map(ws => ({
    name: Worksheet.getName(ws),
    rowCount: Worksheet.rowCount(ws),
    columnCount: Worksheet.columnCount(ws),
    columns: Worksheet.columns(ws).length,
    dimensions: { ...Worksheet.dimensions(ws) }
  }));
  const bytes = new Uint8Array(await Workbook.toBuffer(wb));
  return { sheets, bytes };
}

/**
 * A sheet shaped to make materialisation observable: column B is styled but
 * empty, and row 1 is wider than row 2, so a full-rectangle read has holes to
 * fill in a styled column.
 */
function styledSheet() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  Column.setStyle(ws, 2, { numFmt: "0.00%" });
  Row.setStyle(ws, 3, { font: { bold: true } });
  Cell.setValue(ws, "A1", "h1");
  Cell.setValue(ws, "C1", "h3");
  Cell.setValue(ws, "A2", 1);
  Cell.setValue(ws, "C4", 4);
  return { wb, ws };
}

async function expectNoMutation(
  wb: ReturnType<typeof Workbook.create>,
  read: () => void | Promise<void>
) {
  const before = await fingerprint(wb);
  await read();
  const after = await fingerprint(wb);
  expect(after.sheets).toEqual(before.sheets);
  expect(after.bytes).toEqual(before.bytes);
}

describe("reads do not mutate the workbook", () => {
  describe("Worksheet.toJson", () => {
    it("header: 1", async () => {
      const { wb, ws } = styledSheet();
      let values: unknown;
      await expectNoMutation(wb, () => {
        values = Worksheet.toJson(ws, { header: 1 });
      });
      expect(values).toEqual([
        ["h1", null, "h3"],
        [1, null, null],
        [null, null, null],
        [null, null, 4]
      ]);
    });

    it("header: 1 with raw: false", async () => {
      const { wb, ws } = styledSheet();
      let values: unknown;
      await expectNoMutation(wb, () => {
        values = Worksheet.toJson(ws, { header: 1, raw: false });
      });
      expect(values).toEqual([
        ["h1", null, "h3"],
        ["1", null, null],
        [null, null, null],
        [null, null, "4"]
      ]);
    });

    it('header: "A"', async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(wb, () => void Worksheet.toJson(ws, { header: "A" }));
    });

    it("header: string[]", async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(wb, () => void Worksheet.toJson(ws, { header: ["a", "b", "c"] }));
    });

    it("default first-row header", async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(wb, () => void Worksheet.toJson(ws));
    });

    it("with defaultValue and blankRows", async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(
        wb,
        () => void Worksheet.toJson(ws, { header: 1, defaultValue: 0, blankRows: false })
      );
    });
  });

  describe("Worksheet.toAoa", () => {
    it("leaves the sheet alone", async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(wb, () => void Worksheet.toAoa(ws));
    });

    it("leaves the sheet alone when rows have been spliced out", async () => {
      const { wb, ws } = styledSheet();
      Worksheet.spliceRows(ws, 2, 1);
      await expectNoMutation(wb, () => void Worksheet.toAoa(ws));
    });

    it("preserves explicit empty rows rather than sparse array holes", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A3", 3);

      let values: ReturnType<typeof Worksheet.toAoa> | undefined;
      await expectNoMutation(wb, () => {
        values = Worksheet.toAoa(ws);
      });

      expect(values).toEqual([[1], [], [3]]);
      expect(Object.keys(values!)).toEqual(["0", "1", "2"]);
      expect(1 in values!).toBe(true);
    });

    it("keeps rows positioned by slot after a splice", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Worksheet.spliceRows(ws, 2, 1);

      let values: ReturnType<typeof Worksheet.toAoa> | undefined;
      await expectNoMutation(wb, () => {
        values = Worksheet.toAoa(ws);
      });

      // Row 2 now holds the old row 3, and the trailing slot is empty.
      expect(values).toEqual([[1], [3], []]);
    });

    it("does not change what a later Worksheet.getValues returns", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "A2", 2);
      Cell.setValue(ws, "A3", 3);
      Worksheet.spliceRows(ws, 2, 1);

      // The materialising version of `toAoa` created the trailing row that the
      // splice had emptied, so reading the sheet one way changed what reading it
      // another way reported — `getValues` grew from 3 entries to 4.
      const before = Worksheet.getValues(ws);
      Worksheet.toAoa(ws);
      expect(Worksheet.getValues(ws)).toEqual(before);
    });
  });

  describe("Worksheet.getValues / Range.getValues", () => {
    it("leaves the sheet alone", async () => {
      const { wb, ws } = styledSheet();
      await expectNoMutation(wb, () => void Worksheet.getValues(ws));
    });
  });

  describe("column reads", () => {
    it("columnValues does not materialise cells down the column", async () => {
      const { wb, ws } = styledSheet();
      let values: ReturnType<typeof columnValues> | undefined;
      await expectNoMutation(wb, () => {
        values = columnValues(getColumn(ws, 3));
      });
      expect(values).toEqual([, "h3", , , 4]);
    });
  });

  describe("formula snapshot capture", () => {
    it("captures without materialising", async () => {
      const { wb } = styledSheet();
      await expectNoMutation(wb, () => void captureFormulaSnapshot(wb));
    });

    it("captures without materialising after a splice leaves row holes", async () => {
      const { wb, ws } = styledSheet();
      Worksheet.spliceRows(ws, 2, 1);
      await expectNoMutation(wb, () => void captureFormulaSnapshot(wb));
    });
  });

  describe("Anchor geometry", () => {
    it("reading anchor geometry does not create rows or columns", async () => {
      const { wb, ws } = styledSheet();
      const anchor = Anchor.create(ws, { col: 40, row: 60 });
      await expectNoMutation(wb, () => {
        Anchor.colWidth(anchor);
        Anchor.rowHeight(anchor);
        Anchor.col(anchor);
        Anchor.row(anchor);
      });
    });
  });
});
