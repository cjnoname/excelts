import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";

describe("Worksheet", () => {
  describe("Views", () => {
    it("adjusts collapsed property of columns", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("sheet1");

      const col1 = ws.getColumn(1);
      const col2 = ws.getColumn(2);
      const col3 = ws.getColumn(3);
      expect(col1.collapsed).toBe(false);
      expect(col2.collapsed).toBe(false);
      expect(col3.collapsed).toBe(false);

      col1.outlineLevel = 0;
      col2.outlineLevel = 1;
      col3.outlineLevel = 2;
      expect(col1.collapsed).toBe(false);
      expect(col2.collapsed).toBe(true);
      expect(col3.collapsed).toBe(true);

      ws.properties.outlineLevelCol = 2;
      expect(col1.collapsed).toBe(false);
      expect(col2.collapsed).toBe(false);
      expect(col3.collapsed).toBe(true);

      ws.properties.outlineLevelCol = 3;
      expect(col1.collapsed).toBe(false);
      expect(col2.collapsed).toBe(false);
      expect(col3.collapsed).toBe(false);
    });

    it("adjusts collapsed property of row", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("sheet1");

      const row1 = ws.getRow(1);
      const row2 = ws.getRow(2);
      const row3 = ws.getRow(3);
      expect(row1.collapsed).toBe(false);
      expect(row2.collapsed).toBe(false);
      expect(row3.collapsed).toBe(false);

      row1.outlineLevel = 0;
      row2.outlineLevel = 1;
      row3.outlineLevel = 2;
      expect(row1.collapsed).toBe(false);
      expect(row2.collapsed).toBe(true);
      expect(row3.collapsed).toBe(true);

      ws.properties.outlineLevelRow = 2;
      expect(row1.collapsed).toBe(false);
      expect(row2.collapsed).toBe(false);
      expect(row3.collapsed).toBe(true);

      ws.properties.outlineLevelRow = 3;
      expect(row1.collapsed).toBe(false);
      expect(row2.collapsed).toBe(false);
      expect(row3.collapsed).toBe(false);
    });

    it("sets outline levels via column headers", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("sheet1");

      ws.columns = [
        { key: "id", width: 10, outlineLevel: 1 },
        { key: "name", width: 32, outlineLevel: 2 },
        { key: "dob", width: 10, outlineLevel: 3 }
      ];

      expect(ws.getColumn(1).outlineLevel).toBe(1);
      expect(ws.getColumn(2).outlineLevel).toBe(2);
      expect(ws.getColumn(3).outlineLevel).toBe(3);
    });
  });
});
