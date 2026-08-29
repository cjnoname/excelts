import { getSheetModel } from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

/**
 * Page breaks are stored in `brk/@max` / `brk/@min`, which are **0-based**
 * indices, while the public API takes the 1-based row/column numbers used
 * everywhere else. These tests pin that conversion — including the defaults,
 * which are the last valid index rather than a sentinel: the row default was
 * 16838 for a long time, a value past Excel's last column XFD (0-based 16383)
 * that only looked plausible because nothing asserted it.
 */
const LAST_COLUMN_INDEX = 16383; // XFD, 0-based
const LAST_ROW_INDEX = 1048575; // row 1048576, 0-based

function sheet() {
  const wb = Workbook.create();
  return Workbook.addWorksheet(wb, "test");
}

describe("Worksheet", () => {
  describe("Page Breaks", () => {
    // =========================================================================
    // Row Breaks
    // =========================================================================

    it("adds multiple row breaks", () => {
      const ws = sheet();

      Cell.setValue(ws, "A1", "A1");
      Cell.setValue(ws, "B1", "B1");
      Cell.setValue(ws, "A2", "A2");
      Cell.setValue(ws, "B2", "B2");
      Cell.setValue(ws, "A3", "A3");
      Cell.setValue(ws, "B3", "B3");

      Row.addPageBreak(ws, 1);
      Row.addPageBreak(ws, 2);

      expect(ws.rowBreaks.length).toBe(2);
    });

    it("spans the full sheet width by default, up to Excel's last column", () => {
      const ws = sheet();

      Cell.setValue(ws, "A1", "data");
      Row.addPageBreak(ws, 1);

      expect(ws.rowBreaks).toEqual([{ id: 1, max: LAST_COLUMN_INDEX, man: 1 }]);
    });

    /**
     * `CT_Break` allows `min`/`max` to narrow a break to a band of columns, and
     * this API deliberately does not expose that. Excel's UI cannot author such a
     * break, a file Excel wrote carries `max="16383"` with no `min`, and
     * `pdf/excel-bridge.ts` reads only `brk/@id` — so a band would be a value
     * neither Excel nor this library's PDF export can observe. Never emit `min`.
     */
    it("never emits a partial break", () => {
      const ws = sheet();

      Row.addPageBreak(ws, 4);
      Row.addPageBreak(ws, 9);

      for (const brk of ws.rowBreaks) {
        expect(brk).not.toHaveProperty("min");
        expect(brk.max).toBe(LAST_COLUMN_INDEX);
      }
    });

    it("rowBreaks starts as empty array", () => {
      const ws = sheet();

      expect(ws.rowBreaks).toEqual([]);
    });

    it("row breaks survive XLSX round-trip", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");

      Cell.setValue(ws, "A1", "above break");
      Cell.setValue(ws, "A2", "below break");
      Row.addPageBreak(ws, 1);

      const buffer = await Workbook.toBuffer(wb);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "test")!;
      expect(ws2.rowBreaks).toEqual([{ id: 1, max: LAST_COLUMN_INDEX, man: 1 }]);
    });

    it("rowBreaks is included in worksheet model", () => {
      const ws = sheet();

      Cell.setValue(ws, "A1", "data");
      Row.addPageBreak(ws, 1);
      Row.addPageBreak(ws, 3);

      const model = getSheetModel(ws);
      expect(model.rowBreaks).toEqual([
        { id: 1, max: LAST_COLUMN_INDEX, man: 1 },
        { id: 3, max: LAST_COLUMN_INDEX, man: 1 }
      ]);
    });

    // =========================================================================
    // Column Breaks
    // =========================================================================

    it("adds a single column break", () => {
      const ws = sheet();

      Cell.setValue(ws, "A1", "A1");
      Cell.setValue(ws, "B1", "B1");
      Cell.setValue(ws, "C1", "C1");

      Column.addPageBreak(ws, 1);

      expect(ws.colBreaks).toEqual([{ id: 1, max: LAST_ROW_INDEX, man: 1 }]);
    });

    it("adds multiple column breaks", () => {
      const ws = sheet();

      for (let col = 1; col <= 10; col++) {
        Cell.setValue(ws, 1, col, `Col ${col}`);
      }

      Column.addPageBreak(ws, 3);
      Column.addPageBreak(ws, 6);
      Column.addPageBreak(ws, 9);

      expect(ws.colBreaks.map(b => b.id)).toEqual([3, 6, 9]);
    });

    it("never emits a partial break", () => {
      const ws = sheet();

      Column.addPageBreak(ws, "B");

      expect(ws.colBreaks[0]).not.toHaveProperty("min");
      expect(ws.colBreaks[0].max).toBe(LAST_ROW_INDEX);
    });

    it("adds column break using column letter", () => {
      const ws = sheet();

      Column.addPageBreak(ws, "D");

      expect(ws.colBreaks.length).toBe(1);
      expect(ws.colBreaks[0].id).toBe(4); // D is column 4
    });

    it("resolves a column key to its number", () => {
      const ws = sheet();

      Worksheet.setColumns(ws, [
        { header: "Name", key: "name", width: 20 },
        { header: "Total", key: "total", width: 12 }
      ]);
      Column.addPageBreak(ws, "total");

      expect(ws.colBreaks[0].id).toBe(2);
    });

    it("initializes colBreaks as empty array", () => {
      const ws = sheet();

      expect(ws.colBreaks).toEqual([]);
    });

    it("colBreaks is included in worksheet model", () => {
      const ws = sheet();

      Column.addPageBreak(ws, 2);

      const model = getSheetModel(ws);
      expect(model.colBreaks).toEqual([{ id: 2, max: LAST_ROW_INDEX, man: 1 }]);
    });

    it("column breaks survive XLSX round-trip", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");

      Cell.setValue(ws, "A1", "left of break");
      Cell.setValue(ws, "B1", "right of break");
      Column.addPageBreak(ws, "A");

      const buffer = await Workbook.toBuffer(wb);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const ws2 = Workbook.getWorksheet(wb2, "test")!;
      expect(ws2.colBreaks).toEqual([{ id: 1, max: LAST_ROW_INDEX, man: 1 }]);
    });

    // =========================================================================
    // Row + Column Coexistence
    // =========================================================================

    it("row and column breaks can coexist", () => {
      const ws = sheet();

      Cell.setValue(ws, "A1", "data");
      Row.addPageBreak(ws, 1);
      Column.addPageBreak(ws, 1);

      expect(ws.rowBreaks.length).toBe(1);
      expect(ws.colBreaks.length).toBe(1);
    });
  });
});
