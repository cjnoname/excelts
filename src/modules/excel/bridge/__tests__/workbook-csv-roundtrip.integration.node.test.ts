import { readCsvFile, writeCsvFile } from "@excel/bridge/csv-bridge.node";
import { cellGetValue, cellType } from "@excel/core/cell";
import { ValueType } from "@excel/core/enums";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { testFilePath } from "@test/utils";
import { describe, it, expect } from "vitest";

describe("Workbook", () => {
  describe("CSV", () => {
    it("roundtrips numbers/strings/formulas/dates (from legacy examples)", async () => {
      const csvFile = testFilePath("csv-roundtrip-from-examples", ".csv");

      // Write a CSV (mirrors former src/examples/testCsvOut.ts)
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "blort");

      Worksheet.setColumns(ws, [
        { header: "Col 1", key: "key", width: 25 },
        { header: "Col 2", key: "name", width: 25 },
        { header: "Col 3", key: "age", width: 21 },
        { header: "Col 4", key: "addr1", width: 18 },
        { header: "Col 5", key: "addr2", width: 8 }
      ]);

      Cell.setValue(ws, "A2", 7);
      Cell.setValue(ws, "B2", "Hello, World!");
      Cell.setValue(ws, "C2", -5.55);
      Cell.setValue(ws, "D2", new Date(2015, 2, 10, 7, 8, 9));
      Cell.setValue(ws, "E2", "Hello, World!");

      Cell.setValue(ws, "A3", { text: "www.google.com", hyperlink: "http://www.google.com" });
      Cell.setValue(ws, "A4", "Boo!");
      Cell.setValue(ws, "C4", "Hoo!");

      Cell.setValue(ws, "A5", 1);
      Cell.setValue(ws, "B5", 2);
      Cell.setValue(ws, "C5", { formula: "A5+B5", result: 3 });

      Cell.setValue(ws, "A6", "Hello");
      Cell.setValue(ws, "B6", "World");
      Cell.setValue(ws, "C6", {
        formula: 'CONCATENATE(A6,", ",B6,"!")',
        result: "Hello, World!"
      });

      Cell.setValue(ws, "A7", 1);
      Cell.setValue(ws, "B7", 2);
      // C7 intentionally left blank
      Cell.setValue(ws, "D7", 4);

      Cell.setValue(ws, "A10", "<");
      Cell.setValue(ws, "B10", ">");
      Cell.setValue(ws, "C10", "<a>");
      Cell.setValue(ws, "D10", "><");

      await writeCsvFile(wb, csvFile, { dateFormat: "DD/MM/YYYY HH:mm:ss" });

      // Read it back (mirrors former src/examples/testCsvIn.ts)
      const wb2 = Workbook.create();
      await readCsvFile(wb2, csvFile, { dateFormats: ["DD/MM/YYYY HH:mm:ss"] });

      const ws2 = Workbook.getWorksheet(wb2)!;
      expect(ws2).toBeTruthy();

      expect(Cell.getType(ws2, "A2")).toBe(ValueType.Number);
      expect(Cell.getValue(ws2, "A2")).toBe(7);

      expect(Cell.getType(ws2, "B2")).toBe(ValueType.String);
      expect(Cell.getValue(ws2, "B2")).toBe("Hello, World!");

      expect(Cell.getType(ws2, "C2")).toBe(ValueType.Number);
      expect(Math.abs((Cell.getValue(ws2, "C2") as number) + 5.55)).toBeLessThan(0.000001);

      const d2 = getCell(ws2, "D2");
      expect(cellType(d2)).toBe(ValueType.Date);
      expect(cellGetValue(d2)).toBeInstanceOf(Date);
      const date = cellGetValue(d2) as Date;
      expect(date.getFullYear()).toBe(2015);
      expect(date.getMonth()).toBe(2);
      expect(date.getDate()).toBe(10);
      expect(date.getHours()).toBe(7);
      expect(date.getMinutes()).toBe(8);
      expect(date.getSeconds()).toBe(9);

      expect(Cell.getType(ws2, "C5")).toBe(ValueType.Number);
      expect(Cell.getValue(ws2, "C5")).toBe(3);

      expect(Cell.getType(ws2, "A7")).toBe(ValueType.Number);
      expect(Cell.getValue(ws2, "A7")).toBe(1);

      expect(Cell.getType(ws2, "B7")).toBe(ValueType.Number);
      expect(Cell.getValue(ws2, "B7")).toBe(2);

      expect(Cell.getType(ws2, "C7")).toBe(ValueType.Null);
      expect(Cell.getValue(ws2, "C7")).toBe(null);

      expect(Cell.getType(ws2, "D7")).toBe(ValueType.Number);
      expect(Cell.getValue(ws2, "D7")).toBe(4);

      expect(Cell.getValue(ws2, "A10")).toBe("<");
      expect(Cell.getValue(ws2, "B10")).toBe(">");
      expect(Cell.getValue(ws2, "C10")).toBe("<a>");
      expect(Cell.getValue(ws2, "D10")).toBe("><");
    }, 6000);
  });
});
