import { testUtils } from "@excel/__tests__/shared";
import { cellGetValue, cellFont, cellNumFmt, cellSetValue } from "@excel/core/cell";
import {
  columnCollapsed,
  columnEquivalentTo,
  columnHeaderCount,
  columnHeaders,
  columnHidden,
  columnIsCustomWidth,
  columnLetter,
  columnOutlineLevel,
  columnSetHidden,
  columnSetOutlineLevel,
  columnToModel
} from "@excel/core/column";
import {
  columnEachCell,
  columnSetDefn,
  columnSetBorder,
  columnSetFill,
  columnSetFont,
  columnSetHeader,
  columnSetKey,
  columnSetNumFmt,
  columnSetValues,
  columnValues,
  getCell,
  getColumn,
  rowSetValues
} from "@excel/core/worksheet";
import { Cell, Column, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

describe("Column", () => {
  // ===========================================================================
  // Creation & Basic Properties
  // ===========================================================================

  it("creates by definition with header, key, and width", () => {
    const sheet = testUtils.createSheetMock();

    columnSetDefn(getColumn(sheet, 1), {
      header: "Col 1",
      key: "id1",
      width: 10
    });

    expect(getColumn(sheet, 1).header).toBe("Col 1");
    expect(columnHeaders(getColumn(sheet, 1))).toEqual(["Col 1"]);
    expect(cellGetValue(getCell(sheet, 1, 1))).toBe("Col 1");
    expect(getColumn(sheet, "id1")).toBe(getColumn(sheet, 1));

    rowSetValues(Worksheet.getRow(sheet, 2), { id1: "Hello, World!" });
    expect(cellGetValue(getCell(sheet, 2, 1))).toBe("Hello, World!");
  });

  it("maintains properties (key, number, letter, header)", () => {
    const sheet = testUtils.createSheetMock();

    const column = getColumn(sheet, 1);

    columnSetKey(column, "id1");
    expect(sheet._keys.id1).toBe(column);

    expect(column.number).toBe(1);
    expect(columnLetter(column)).toBe("A");

    columnSetHeader(column, "Col 1");
    expect(getColumn(sheet, 1).header).toBe("Col 1");
    expect(columnHeaders(getColumn(sheet, 1))).toEqual(["Col 1"]);
    expect(cellGetValue(getCell(sheet, 1, 1))).toBe("Col 1");

    columnSetHeader(column, ["Col A1", "Col A2"]);
    expect(getColumn(sheet, 1).header).toEqual(["Col A1", "Col A2"]);
    expect(columnHeaders(getColumn(sheet, 1))).toEqual(["Col A1", "Col A2"]);
    expect(cellGetValue(getCell(sheet, 1, 1))).toBe("Col A1");
    expect(cellGetValue(getCell(sheet, 2, 1))).toBe("Col A2");

    rowSetValues(Worksheet.getRow(sheet, 3), { id1: "Hello, World!" });
    expect(cellGetValue(getCell(sheet, 3, 1))).toBe("Hello, World!");
  });

  // ===========================================================================
  // Model Serialization
  // ===========================================================================

  it("creates model from columns with outlineLevels", () => {
    const sheet = testUtils.createSheetMock();

    columnSetDefn(getColumn(sheet, 1), { header: "Col 1", key: "id1", width: 10 });
    columnSetDefn(getColumn(sheet, 2), { header: "Col 2", key: "name", width: 10 });
    columnSetDefn(getColumn(sheet, 3), { header: "Col 2", key: "dob", width: 10, outlineLevel: 1 });

    const model = columnToModel(sheet._columns);
    expect(model!.length).toBe(2);

    expect(model![0].width).toBe(10);
    expect(model![0].outlineLevel).toBe(0);
    expect(model![0].collapsed).toBe(false);

    expect(model![1].width).toBe(10);
    expect(model![1].outlineLevel).toBe(1);
    expect(model![1].collapsed).toBe(true);
  });

  // ===========================================================================
  // Column Values
  // ===========================================================================

  it("gets column values", () => {
    const sheet = testUtils.createSheetMock();
    cellSetValue(getCell(sheet, 1, 1), "a");
    cellSetValue(getCell(sheet, 2, 1), "b");
    cellSetValue(getCell(sheet, 4, 1), "d");

    expect(columnValues(getColumn(sheet, 1))).toEqual([, "a", "b", , "d"]);
  });

  it("sets column values from dense array", () => {
    const sheet = testUtils.createSheetMock();

    columnSetValues(getColumn(sheet, 1), [2, 3, 5, 7, 11]);

    expect(cellGetValue(getCell(sheet, 1, 1))).toBe(2);
    expect(cellGetValue(getCell(sheet, 2, 1))).toBe(3);
    expect(cellGetValue(getCell(sheet, 3, 1))).toBe(5);
    expect(cellGetValue(getCell(sheet, 4, 1))).toBe(7);
    expect(cellGetValue(getCell(sheet, 5, 1))).toBe(11);
    expect(cellGetValue(getCell(sheet, 6, 1))).toBe(null);
  });

  it("sets column values from explicit sparse array", () => {
    const sheet = testUtils.createSheetMock();
    const values: (number | undefined)[] = [];
    values[2] = 2;
    values[3] = 3;
    values[5] = 5;
    values[11] = 11;
    columnSetValues(getColumn(sheet, 1), values);

    expect(cellGetValue(getCell(sheet, 1, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 2, 1))).toBe(2);
    expect(cellGetValue(getCell(sheet, 3, 1))).toBe(3);
    expect(cellGetValue(getCell(sheet, 4, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 5, 1))).toBe(5);
    expect(cellGetValue(getCell(sheet, 6, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 7, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 8, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 9, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 10, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 11, 1))).toBe(11);
    expect(cellGetValue(getCell(sheet, 12, 1))).toBe(null);
  });

  it("sets column values from elision-style sparse array", () => {
    const sheet = testUtils.createSheetMock();
    columnSetValues(getColumn(sheet, 1), [, , 2, 3, , 5, , 7, , , , 11]);

    expect(cellGetValue(getCell(sheet, 1, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 2, 1))).toBe(2);
    expect(cellGetValue(getCell(sheet, 3, 1))).toBe(3);
    expect(cellGetValue(getCell(sheet, 4, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 5, 1))).toBe(5);
    expect(cellGetValue(getCell(sheet, 6, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 7, 1))).toBe(7);
    expect(cellGetValue(getCell(sheet, 8, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 9, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 10, 1))).toBe(null);
    expect(cellGetValue(getCell(sheet, 11, 1))).toBe(11);
    expect(cellGetValue(getCell(sheet, 12, 1))).toBe(null);
  });

  // ===========================================================================
  // Width & Defaults
  // ===========================================================================

  it("sets default column width when no explicit width given", () => {
    const sheet = testUtils.createSheetMock();

    columnSetDefn(getColumn(sheet, 1), { header: "Col 1", key: "id1", style: { numFmt: "0.00%" } });
    columnSetDefn(getColumn(sheet, 2), {
      header: "Col 2",
      key: "id2",
      style: { numFmt: "0.00%" },
      width: 10
    });
    columnSetNumFmt(getColumn(sheet, 3), "0.00%");

    const model = columnToModel(sheet._columns);
    expect(model!.length).toBe(3);
    expect(model![0].width).toBe(9); // default
    expect(model![1].width).toBe(10); // explicit
    expect(model![2].width).toBe(9); // default
  });

  it("isCustomWidth is true when width differs from default", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { header: "Col 1", width: 20 });
    columnSetDefn(getColumn(sheet, 2), { header: "Col 2" });

    expect(columnIsCustomWidth(getColumn(sheet, 1))).toBe(true);
    expect(columnIsCustomWidth(getColumn(sheet, 2))).toBe(false);
  });

  // ===========================================================================
  // Hidden & Outline
  // ===========================================================================

  it("hidden property can be set and read", () => {
    const sheet = testUtils.createSheetMock();
    const col = getColumn(sheet, 1);

    expect(columnHidden(col)).toBe(false);
    columnSetHidden(col, true);
    expect(columnHidden(col)).toBe(true);
    columnSetHidden(col, false);
    expect(columnHidden(col)).toBe(false);
  });

  it("outlineLevel and collapsed interact correctly", () => {
    const sheet = testUtils.createSheetMock();
    const col = getColumn(sheet, 1);

    expect(col.outlineLevel).toBe(0);
    expect(columnCollapsed(col)).toBe(false);

    columnSetOutlineLevel(col, 1);
    expect(col.outlineLevel).toBe(1);
    // collapsed depends on worksheet.properties.outlineLevelCol
    expect(columnCollapsed(col)).toBe(true);
  });

  // ===========================================================================
  // eachCell
  // ===========================================================================

  it("eachCell iterates over non-empty cells", () => {
    const sheet = testUtils.createSheetMock();
    cellSetValue(getCell(sheet, 1, 1), "a");
    cellSetValue(getCell(sheet, 3, 1), "c");
    cellSetValue(getCell(sheet, 5, 1), "e");

    const collected: Array<{ row: number; value: unknown }> = [];
    columnEachCell(getColumn(sheet, 1), (cell, rowNumber) => {
      collected.push({ row: rowNumber, value: cellGetValue(cell) });
    });

    expect(collected).toEqual([
      { row: 1, value: "a" },
      { row: 3, value: "c" },
      { row: 5, value: "e" }
    ]);
  });

  it("eachCell with includeEmpty iterates all rows up to last", () => {
    const sheet = testUtils.createSheetMock();
    cellSetValue(getCell(sheet, 1, 1), "a");
    cellSetValue(getCell(sheet, 3, 1), "c");

    const rows: number[] = [];
    columnEachCell(getColumn(sheet, 1), { includeEmpty: true }, (_cell, rowNumber) => {
      rows.push(rowNumber);
    });

    // Should include rows 1, 2, 3 (up to last non-empty)
    expect(rows).toContain(1);
    expect(rows).toContain(2);
    expect(rows).toContain(3);
  });

  // ===========================================================================
  // Style Properties
  // ===========================================================================

  it("column style properties propagate to cells", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { header: "Col 1" });
    cellSetValue(getCell(sheet, 2, 1), "data");

    columnSetFont(getColumn(sheet, 1), { bold: true });
    expect(cellFont(getCell(sheet, 1, 1))).toEqual({ bold: true });
    expect(cellFont(getCell(sheet, 2, 1))).toEqual({ bold: true });
  });

  it("column numFmt propagates to cells", () => {
    const sheet = testUtils.createSheetMock();
    cellSetValue(getCell(sheet, 1, 1), 0.5);
    columnSetNumFmt(getColumn(sheet, 1), "0.00%");

    expect(cellNumFmt(getCell(sheet, 1, 1))).toBe("0.00%");
  });

  // ===========================================================================
  // headerCount
  // ===========================================================================

  it("headerCount reflects number of header rows", () => {
    const sheet = testUtils.createSheetMock();
    const col = getColumn(sheet, 1);
    columnSetDefn(col, { header: "Single" });
    expect(columnHeaderCount(col)).toBe(1);

    columnSetHeader(col, ["Row1", "Row2", "Row3"]);
    expect(columnHeaderCount(col)).toBe(3);
  });

  // ===========================================================================
  // equivalentTo
  // ===========================================================================

  it("equivalentTo returns true for columns with same properties", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { width: 10 });
    columnSetDefn(getColumn(sheet, 2), { width: 10 });

    expect(columnEquivalentTo(getColumn(sheet, 1), getColumn(sheet, 2))).toBe(true);
  });

  it("equivalentTo returns false for columns with different width", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { width: 10 });
    columnSetDefn(getColumn(sheet, 2), { width: 20 });

    expect(columnEquivalentTo(getColumn(sheet, 1), getColumn(sheet, 2))).toBe(false);
  });

  // ===========================================================================
  // XLSX Round-Trip (via Workbook)
  // ===========================================================================

  it("column properties survive XLSX round-trip", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");
    Worksheet.setColumns(ws, [
      { header: "ID", key: "id", width: 10 },
      { header: "Name", key: "name", width: 32 },
      { header: "DOB", key: "dob", width: 15, outlineLevel: 1 }
    ]);
    Worksheet.addRow(ws, { id: 1, name: "Alice", dob: new Date(1990, 0, 1) });

    const buffer = await Workbook.toBuffer(wb);
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);

    const ws2 = Workbook.getWorksheet(wb2, "test")!;
    expect(Column.getWidth(ws2, 1)).toBe(10);
    expect(Column.getWidth(ws2, 2)).toBe(32);
    expect(Column.getWidth(ws2, 3)).toBe(15);
    expect(columnOutlineLevel(getColumn(ws2, 3))).toBe(1);
  });

  describe("style isolation", () => {
    it("mutating a cell border after col.border broadcast does not leak to other cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Cell.setValue(ws, "A1", "row1");
      Cell.setValue(ws, "A2", "row2");

      columnSetBorder(getColumn(ws, 1), { top: { style: "thin" }, bottom: { style: "thin" } });

      Cell.getStyle(ws, "A1").border!.top = { style: "thick" };

      expect(Cell.getStyle(ws, "A1").border!.top).toEqual({ style: "thick" });
      expect(Cell.getStyle(ws, "A2").border!.top).toEqual({ style: "thin" });
    });

    it("mutating a cell fill after col.fill broadcast does not leak to other cells", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Cell.setValue(ws, "A1", "row1");
      Cell.setValue(ws, "A2", "row2");

      columnSetFill(getColumn(ws, 1), {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFF0000" }
      });

      (Cell.getStyle(ws, "A1").fill as any).fgColor = { argb: "FF00FF00" };

      expect((Cell.getStyle(ws, "A1").fill as any).fgColor).toEqual({ argb: "FF00FF00" });
      expect((Cell.getStyle(ws, "A2").fill as any).fgColor).toEqual({ argb: "FFFF0000" });
    });
  });

  // ===========================================================================
  // Nested column-key paths (addRow / Row.values(row) with dotted keys)
  // ===========================================================================

  describe("nested column key paths", () => {
    it("resolves dotted keys against nested objects", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [
        { header: "Name", key: "name", width: 20 },
        { header: "City", key: "address.city", width: 20 },
        { header: "Zip", key: "address.zip", width: 10 }
      ]);
      Worksheet.addRow(ws, { name: "Alice", address: { city: "Sydney", zip: "2000" } });

      expect(Cell.getValue(ws, "A2")).toBe("Alice");
      expect(Cell.getValue(ws, "B2")).toBe("Sydney");
      expect(Cell.getValue(ws, "C2")).toBe("2000");
    });

    it("resolves deeply nested keys (three levels)", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [{ header: "Country", key: "address.geo.country", width: 20 }]);
      Worksheet.addRow(ws, { address: { geo: { country: "AU" } } });

      expect(Cell.getValue(ws, "A2")).toBe("AU");
    });

    it("skips the cell when a nested path segment is missing", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [
        { header: "Name", key: "name", width: 20 },
        { header: "City", key: "address.city", width: 20 }
      ]);
      // No `address` at all → the dotted column simply has no value.
      Worksheet.addRow(ws, { name: "Bob" });

      expect(Cell.getValue(ws, "A2")).toBe("Bob");
      expect(Cell.getValue(ws, "B2")).toBeNull();
    });

    it("skips the cell when an intermediate segment is not an object", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [{ header: "City", key: "address.city", width: 20 }]);
      // `address` is a primitive, so `.city` cannot be followed.
      Worksheet.addRow(ws, { address: "not-an-object" } as any);

      expect(Cell.getValue(ws, "A2")).toBeNull();
    });

    it("prefers a literal flat key containing a dot over nested traversal", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [{ header: "Dotted", key: "a.b", width: 20 }]);
      // A flat property literally named "a.b" wins over walking a → b.
      Worksheet.addRow(ws, { "a.b": "flat-wins", a: { b: "nested-loses" } } as any);

      expect(Cell.getValue(ws, "A2")).toBe("flat-wins");
    });

    it("leaves plain (non-dotted) keys behaving exactly as before", () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [
        { header: "ID", key: "id", width: 10 },
        { header: "Name", key: "name", width: 20 }
      ]);
      Worksheet.addRow(ws, { id: 7, name: "Carol" });

      expect(Cell.getValue(ws, "A2")).toBe(7);
      expect(Cell.getValue(ws, "B2")).toBe("Carol");
    });

    it("round-trips nested-key values through XLSX", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "test");
      Worksheet.setColumns(ws, [
        { header: "Name", key: "name", width: 20 },
        { header: "City", key: "address.city", width: 20 }
      ]);
      Worksheet.addRow(ws, { name: "Dave", address: { city: "Perth" } });

      const buffer = await Workbook.toBuffer(wb);
      const wb2 = Workbook.create();
      await Workbook.read(wb2, buffer);
      const ws2 = Workbook.getWorksheet(wb2, "test")!;

      expect(Cell.getValue(ws2, "A2")).toBe("Dave");
      expect(Cell.getValue(ws2, "B2")).toBe("Perth");
    });
  });
});
