import { cellDataValidation, cellGetValue, cellSetDataValidation } from "@excel/core/cell";
import { getWorksheets } from "@excel/core/workbook";
import {
  addAOA,
  addJSON,
  getCell,
  getSheetModel,
  getSheetName,
  toAOA,
  toJSON
} from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import type { CellValue, WorksheetViewFrozen } from "@excel/types";
import { excelToDate } from "@utils/utils";
import { describe, it, expect } from "vitest";

describe("Worksheet", () => {
  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Create a worksheet from AOA data for quick test setup */
  function createWsFromAOA(data: CellValue[][]) {
    const wb = Workbook.create();
    return addAOA(Workbook.addWorksheet(wb, "Sheet1"), data);
  }

  // ===========================================================================
  // addJSON
  // ===========================================================================

  describe("addJSON", () => {
    it("adds JSON data with headers", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addJSON(ws, [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 }
      ]);

      expect(Cell.getValue(ws, "A1")).toBe("name");
      expect(Cell.getValue(ws, "B1")).toBe("age");
      expect(Cell.getValue(ws, "A2")).toBe("Alice");
      expect(Cell.getValue(ws, "B2")).toBe(30);
      expect(Cell.getValue(ws, "A3")).toBe("Bob");
      expect(Cell.getValue(ws, "B3")).toBe(25);
    });

    it("respects header option for ordering", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addJSON(ws, [{ name: "Alice", age: 30, city: "NYC" }], { header: ["age", "name"] });

      expect(Cell.getValue(ws, "A1")).toBe("age");
      expect(Cell.getValue(ws, "B1")).toBe("name");
      expect(Cell.getValue(ws, "C1")).toBe("city");
      expect(Cell.getValue(ws, "A2")).toBe(30);
      expect(Cell.getValue(ws, "B2")).toBe("Alice");
      expect(Cell.getValue(ws, "C2")).toBe("NYC");
    });

    it("skips header when skipHeader is true", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addJSON(ws, [{ name: "Alice", age: 30 }], { skipHeader: true });

      expect(Cell.getValue(ws, "A1")).toBe("Alice");
      expect(Cell.getValue(ws, "B1")).toBe(30);
    });

    it("adds JSON data with origin offset", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addAOA(ws, [["Header1", "Header2"]]);
      addJSON(ws, [{ a: 1, b: 2 }], { origin: "A2", skipHeader: true });

      expect(Cell.getValue(ws, "A1")).toBe("Header1");
      expect(Cell.getValue(ws, "A2")).toBe(1);
      expect(Cell.getValue(ws, "B2")).toBe(2);
    });

    it("appends to bottom with origin: -1", () => {
      const ws = createWsFromAOA([
        ["a", "b"],
        [1, 2]
      ]);
      Worksheet.addJson(ws, [{ c: 3, d: 4 }], { origin: -1 });

      expect(cellGetValue(getCell(ws, "A3"))).toBe("c");
      expect(cellGetValue(getCell(ws, "B3"))).toBe("d");
      expect(cellGetValue(getCell(ws, "A4"))).toBe(3);
      expect(cellGetValue(getCell(ws, "B4"))).toBe(4);
    });

    it("returns this for chaining", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const result = addJSON(ws, [{ a: 1 }]);
      expect(result).toBe(ws);
    });

    it("handles empty data array", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const result = addJSON(ws, []);
      expect(result).toBe(ws);
      expect(Worksheet.rowCount(ws)).toBe(0);
    });
  });

  // ===========================================================================
  // toJSON
  // ===========================================================================

  describe("toJSON", () => {
    it("converts worksheet to JSON array (default: first row as header)", () => {
      const ws = createWsFromAOA([
        ["name", "age"],
        ["Alice", 30],
        ["Bob", 25]
      ]);

      const result = Worksheet.toJson(ws);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Alice", age: 30 });
      expect(result[1]).toMatchObject({ name: "Bob", age: 25 });
    });

    it("returns array of arrays with header: 1", () => {
      const ws = createWsFromAOA([
        ["name", "age"],
        ["Alice", 30],
        ["Bob", 25]
      ]);

      const result = Worksheet.toJson(ws, { header: 1 });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(["name", "age"]);
      expect(result[1]).toEqual(["Alice", 30]);
      expect(result[2]).toEqual(["Bob", 25]);
    });

    it("uses column letters as keys with header: 'A'", () => {
      const ws = createWsFromAOA([
        ["name", "age"],
        ["Alice", 30]
      ]);

      const result = Worksheet.toJson(ws, { header: "A" });

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ A: "name", B: "age" });
      expect(result[1]).toMatchObject({ A: "Alice", B: 30 });
    });

    it("uses custom keys with header: string[]", () => {
      const ws = createWsFromAOA([
        ["Alice", 30],
        ["Bob", 25]
      ]);

      const result = Worksheet.toJson(ws, { header: ["person", "years"] });

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ person: "Alice", years: 30 });
      expect(result[1]).toMatchObject({ person: "Bob", years: 25 });
    });

    it("handles empty cells with defaultValue", () => {
      const ws = createWsFromAOA([
        ["col1", "col2"],
        ["value", null]
      ]);

      const result = Worksheet.toJson(ws, { defaultValue: "" });

      expect(result[0]).toMatchObject({ col1: "value", col2: "" });
    });

    it("skips blank rows by default for objects", () => {
      const ws = createWsFromAOA([["name"], ["Alice"], [null], ["Bob"]]);

      const result = Worksheet.toJson(ws);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Alice" });
      expect(result[1]).toMatchObject({ name: "Bob" });
    });

    it("includes blank rows with blankRows: true for objects", () => {
      const ws = createWsFromAOA([["name"], ["Alice"], [null], ["Bob"]]);

      const result = Worksheet.toJson(ws, { blankRows: true });

      expect(result).toHaveLength(3);
    });

    it("includes blank rows by default with header: 1", () => {
      const ws = createWsFromAOA([["name"], ["Alice"], [null], ["Bob"]]);

      const result = Worksheet.toJson(ws, { header: 1 });

      expect(result).toHaveLength(4);
    });

    it("disambiguates duplicate headers", () => {
      const ws = createWsFromAOA([
        ["name", "name", "name"],
        ["Alice", "Bob", "Charlie"]
      ]);

      const result = Worksheet.toJson(ws);

      expect(result[0]).toHaveProperty("name", "Alice");
      expect(result[0]).toHaveProperty("name_1", "Bob");
      expect(result[0]).toHaveProperty("name_2", "Charlie");
    });

    it("returns formatted text with raw: false", () => {
      const ws = createWsFromAOA([
        ["name", "age", "birthday"],
        ["Alice", 30, new Date(1994, 5, 15)],
        ["Bob", 25, new Date(1999, 11, 25)]
      ]);

      const result = Worksheet.toJson(ws, { raw: false });

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Alice", age: "30" });
      expect(result[1]).toMatchObject({ name: "Bob", age: "25" });
      expect(typeof result[0].birthday).toBe("string");
      expect(typeof result[1].birthday).toBe("string");
    });

    it("returns raw values by default (raw: true/undefined)", () => {
      const date1 = new Date(1994, 5, 15);
      const date2 = new Date(1999, 11, 25);
      const ws = createWsFromAOA([
        ["name", "age", "birthday"],
        ["Alice", 30, date1],
        ["Bob", 25, date2]
      ]);

      const result = Worksheet.toJson(ws);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Alice", age: 30 });
      expect(result[1]).toMatchObject({ name: "Bob", age: 25 });
      expect(result[0].birthday).toEqual(date1);
      expect(result[1].birthday).toEqual(date2);
    });

    it("formats time values correctly with raw: false (timezone-independent)", () => {
      const timeSerial = 32 / 86400;
      const timeAsDate = new Date(Math.round((timeSerial - 25569) * 86400000));

      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "time");
      Cell.setValue(ws, "A2", timeAsDate);
      Cell.setStyle(ws, "A2", { numFmt: "h:mm:ss" });

      const result = toJSON(ws, { raw: false });

      expect(result).toHaveLength(1);
      expect(result[0].time).toBe("0:00:32");
    });

    it("formats formula result with number result correctly", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "total");
      Cell.setValue(ws, "A2", { formula: "SUM(B1:B10)", result: 1234.567 });
      Cell.setStyle(ws, "A2", { numFmt: "#,##0.00" });

      const result = toJSON(ws, { raw: false });

      expect(result[0].total).toBe("1,234.57");
    });

    it("formats formula result with elapsed time format", () => {
      const durationSerial = 1.5;
      // Through the library's own converter, not a hand-rolled `(serial - 25569) * 86400000`. That expression
      // is the linear model, which placed serial 0 at 1899-12-30 and so disagreed with Excel by a day for
      // everything below serial 61 — the very defect the converter now corrects. A test that builds its input
      // with a private copy of the arithmetic it is exercising cannot notice when that arithmetic is fixed.
      const durationAsDate = excelToDate(durationSerial, false);

      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "elapsed");
      Cell.setValue(ws, "A2", { formula: "B1-C1", result: durationAsDate });
      Cell.setStyle(ws, "A2", { numFmt: "[h]:mm:ss" });

      const result = toJSON(ws, { raw: false });

      expect(result[0].elapsed).toBe("36:00:00");
    });

    it("respects string range option", () => {
      const ws = createWsFromAOA([
        ["A", "B", "C", "D"],
        [1, 2, 3, 4],
        [5, 6, 7, 8]
      ]);

      const result = Worksheet.toJson(ws, { header: 1, range: "B1:C3" });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(["B", "C"]);
      expect(result[1]).toEqual([2, 3]);
      expect(result[2]).toEqual([6, 7]);
    });

    it("respects numeric range option (starting row)", () => {
      const ws = createWsFromAOA([
        ["header1", "header2"],
        ["skip1", "skip2"],
        ["name", "age"],
        ["Alice", 30]
      ]);

      // range: 2 means start at 0-indexed row 2 (which is 1-indexed row 3)
      const result = Worksheet.toJson(ws, { range: 2 });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: "Alice", age: 30 });
    });

    it("returns empty array for empty worksheet", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Empty");

      expect(toJSON(ws)).toEqual([]);
      expect(toJSON(ws, { header: 1 })).toEqual([]);
    });
  });

  // ===========================================================================
  // addAOA
  // ===========================================================================

  describe("addAOA", () => {
    it("adds array of arrays to worksheet", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addAOA(ws, [
        ["Name", "Age"],
        ["Alice", 30],
        ["Bob", 25]
      ]);

      expect(Cell.getValue(ws, "A1")).toBe("Name");
      expect(Cell.getValue(ws, "B1")).toBe("Age");
      expect(Cell.getValue(ws, "A2")).toBe("Alice");
      expect(Cell.getValue(ws, "B2")).toBe(30);
    });

    it("handles origin option", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addAOA(ws, [["a", "b"]], { origin: "C3" });

      expect(Cell.getValue(ws, "C3")).toBe("a");
      expect(Cell.getValue(ws, "D3")).toBe("b");
    });

    it("handles different data types", () => {
      const date = new Date("2024-01-01");
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      addAOA(ws, [["string", 123, true, date, null]]);

      expect(Cell.getValue(ws, "A1")).toBe("string");
      expect(Cell.getValue(ws, "B1")).toBe(123);
      expect(Cell.getValue(ws, "C1")).toBe(true);
      expect(Cell.getValue(ws, "D1")).toEqual(date);
    });

    it("appends with origin: -1", () => {
      const ws = createWsFromAOA([["Row1"], ["Row2"]]);
      Worksheet.addAoa(ws, [["Row3"]], { origin: -1 });

      expect(cellGetValue(getCell(ws, "A3"))).toBe("Row3");
    });

    it("returns this for chaining", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const result = addAOA(ws, [["a"]]);
      expect(result).toBe(ws);
    });

    it("handles empty data array", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const result = addAOA(ws, []);
      expect(result).toBe(ws);
      expect(Worksheet.rowCount(ws)).toBe(0);
    });
  });

  // ===========================================================================
  // toAOA
  // ===========================================================================

  describe("toAOA", () => {
    it("converts worksheet to array of arrays", () => {
      const ws = createWsFromAOA([
        ["Name", "Age"],
        ["Alice", 30]
      ]);

      const result = Worksheet.toAoa(ws);

      expect(result[0]).toEqual(["Name", "Age"]);
      expect(result[1]).toEqual(["Alice", 30]);
    });
  });

  // ===========================================================================
  // XLSX Round-Trip
  // ===========================================================================

  describe("XLSX round-trip", () => {
    it("addJSON → writeBuffer → load → toJSON preserves data", async () => {
      const wb1 = Workbook.create();
      addJSON(Workbook.addWorksheet(wb1, "Data"), [
        { name: "Alice", age: 30, active: true },
        { name: "Bob", age: 25, active: false }
      ]);

      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const result = toJSON(Workbook.getWorksheet(wb2, "Data")!);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Alice", age: 30, active: true });
      expect(result[1]).toMatchObject({ name: "Bob", age: 25, active: false });
    });

    it("addAOA → writeBuffer → load → toAOA preserves data", async () => {
      const wb1 = Workbook.create();
      addAOA(Workbook.addWorksheet(wb1, "Data"), [
        ["X", "Y"],
        [1, 2],
        [3, 4]
      ]);

      const buffer = await Workbook.toBuffer(wb1);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);

      const result = toAOA(Workbook.getWorksheet(wb2, "Data")!);
      expect(result[0]).toEqual(["X", "Y"]);
      expect(result[1]).toEqual([1, 2]);
      expect(result[2]).toEqual([3, 4]);
    });
  });

  // ===========================================================================
  // importSheet
  // ===========================================================================

  describe("importSheet", () => {
    it("imports worksheet data to a new workbook", () => {
      const wb1 = Workbook.create();
      const ws1 = addJSON(Workbook.addWorksheet(wb1, "Source"), [{ name: "Alice", age: 30 }]);

      const wb2 = Workbook.create();
      Workbook.importSheet(wb2, ws1, "Imported");

      expect(getWorksheets(wb2)).toHaveLength(1);
      expect(getSheetName(getWorksheets(wb2)[0])).toBe("Imported");
      expect(Cell.getValue(getWorksheets(wb2)[0], "A1")).toBe("name");
      expect(Cell.getValue(getWorksheets(wb2)[0], "A2")).toBe("Alice");
    });

    it("uses source name when no name provided", () => {
      const wb1 = Workbook.create();
      const ws1 = addAOA(Workbook.addWorksheet(wb1, "OriginalName"), [["data"]]);

      const wb2 = Workbook.create();
      Workbook.importSheet(wb2, ws1);

      expect(getSheetName(getWorksheets(wb2)[0])).toBe("OriginalName");
    });

    it("copies column widths", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      Column.setWidth(ws1, 1, 20);
      Column.setWidth(ws1, 2, 40);
      Cell.setValue(ws1, "A1", "data");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(Column.getWidth(ws2, 1)).toBe(20);
      expect(Column.getWidth(ws2, 2)).toBe(40);
    });

    it("copies cell styles", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      Cell.setValue(ws1, "A1", "styled");
      Cell.setStyle(ws1, "A1", { font: { bold: true, size: 16 } });

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(Cell.getValue(ws2, "A1")).toBe("styled");
      expect(Cell.getStyle(ws2, "A1").font!.bold).toBe(true);
      expect(Cell.getStyle(ws2, "A1").font!.size).toBe(16);
    });

    it("copies merged cells", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      Cell.setValue(ws1, "A1", "merged");
      Worksheet.merge(ws1, "A1:C3");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(getSheetModel(ws2).mergeCells).toContain("A1:C3");
      expect(Cell.getValue(ws2, "A1")).toBe("merged");
    });

    it("copies row heights", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      Row.setHeight(ws1, 1, 30);
      Row.setHeight(ws1, 2, 50);
      Cell.setValue(ws1, "A1", "tall row");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(Row.getHeight(ws2, 1)).toBe(30);
      expect(Row.getHeight(ws2, 2)).toBe(50);
    });

    it("copies data validations", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      cellSetDataValidation(getCell(ws1, "A1"), {
        type: "list",
        formulae: ['"Yes,No"']
      });

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(cellDataValidation(getCell(ws2, "A1"))).toEqual({
        type: "list",
        formulae: ['"Yes,No"']
      });
    });

    it("copies views (frozen panes)", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      ws1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
      Cell.setValue(ws1, "A1", "header");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(ws2.views).toHaveLength(1);
      const view = ws2.views[0] as WorksheetViewFrozen;
      expect(view.state).toBe("frozen");
      expect(view.xSplit).toBe(1);
      expect(view.ySplit).toBe(1);
    });

    it("copies worksheet state (hidden)", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      ws1.state = "hidden";
      Cell.setValue(ws1, "A1", "data");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(ws2.state).toBe("hidden");
    });

    it("copies auto filter", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      Cell.setValue(ws1, "A1", "Name");
      Cell.setValue(ws1, "B1", "Age");
      ws1.autoFilter = "A1:B1";

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(ws2.autoFilter).toBe("A1:B1");
    });

    it("copies page setup and header/footer", () => {
      const wb1 = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb1, "Source");
      ws1.pageSetup.orientation = "landscape";
      ws1.headerFooter.oddHeader = "Page &P";
      Cell.setValue(ws1, "A1", "data");

      const wb2 = Workbook.create();
      const ws2 = Workbook.importSheet(wb2, ws1);

      expect(ws2.pageSetup.orientation).toBe("landscape");
      expect(ws2.headerFooter.oddHeader).toBe("Page &P");
    });
  });
});
