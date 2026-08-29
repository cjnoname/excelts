import { testUtils } from "@excel/__tests__/shared";
import { cellBorder, cellFont, cellGetValue, cellSetValue, cellType } from "@excel/core/cell";
import { Enums } from "@excel/core/enums";
import type { RowModel } from "@excel/core/row";
import {
  rowActualCellCount,
  rowCellCount,
  rowDimensions,
  rowGetModel,
  rowGetValues,
  rowHasValues,
  rowSetBorder,
  rowSetFont,
  rowSetHidden,
  rowSetOutlineLevel,
  rowValues,
  rowValuesToString
} from "@excel/core/row";
import {
  rowEachCell,
  rowGetCell,
  rowSetModel,
  rowSetValues,
  rowSplice,
  columnSetDefn,
  getColumn
} from "@excel/core/worksheet";
import { Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

describe("Row", () => {
  it("stores cells", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { key: "name" });

    const row1 = Worksheet.getRow(sheet, 1);
    expect(row1.number).toBe(1);
    expect(rowHasValues(row1)).not.toBeTruthy();

    const a1 = rowGetCell(row1, 1);
    expect(a1.address).toBe("A1");
    expect(cellType(a1)).toBe(Enums.ValueType.Null);
    expect(rowHasValues(row1)).not.toBeTruthy();

    expect(rowGetCell(row1, "A")).toBe(a1);
    expect(rowGetCell(row1, "name")).toBe(a1);

    cellSetValue(a1, 5);
    expect(cellType(a1)).toBe(Enums.ValueType.Number);
    expect(rowHasValues(row1)).toBeTruthy();

    const b1 = rowGetCell(row1, 2);
    expect(b1.address).toBe("B1");
    expect(cellType(b1)).toBe(Enums.ValueType.Null);
    expect(cellType(a1)).toBe(Enums.ValueType.Number);

    cellSetValue(b1, "Hello, World!");
    const d1 = rowGetCell(row1, 4);
    cellSetValue(d1, {
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    });

    const values = [
      ,
      5,
      "Hello, World!",
      ,
      { hyperlink: "http://www.hyperlink.com", text: "www.hyperlink.com" }
    ];
    expect(rowValues(row1)).toEqual(values);
    expect(rowDimensions(row1)).toEqual({ min: 1, max: 4 });

    let count = 0;
    rowEachCell(row1, (cell: any, colNumber: any) => {
      expect(cellType(cell)).not.toBe(Enums.ValueType.Null);
      switch (cellType(cell)) {
        case Enums.ValueType.Hyperlink:
          expect(cellGetValue(cell)).toEqual(values[colNumber]);
          break;
        default:
          expect(cellGetValue(cell)).toBe(values[colNumber]);
          break;
      }
      count++;
    });

    // eachCell should just cover non-null cells
    expect(count).toBe(3);

    const row2 = Worksheet.getRow(sheet, 2);
    expect(rowDimensions(row2)).toBeNull();
  });

  it("stores values by whole row", () => {
    const sheet = testUtils.createSheetMock();
    columnSetDefn(getColumn(sheet, 1), { key: "id" });
    columnSetDefn(getColumn(sheet, 2), { key: "name" });
    columnSetDefn(getColumn(sheet, 3), { key: "dob" });

    const now = new Date();

    const row1 = Worksheet.getRow(sheet, 1);

    // set values by contiguous array
    rowSetValues(row1, [5, "Hello, World!", null]);
    expect(cellGetValue(rowGetCell(row1, 1))).toBe(5);
    expect(cellGetValue(rowGetCell(row1, 2))).toBe("Hello, World!");
    expect(cellGetValue(rowGetCell(row1, 3))).toBeNull();
    expect(rowValues(row1)).toEqual([, 5, "Hello, World!"]);

    // set values by sparse array
    const values: any[] = [];
    values[1] = 7;
    values[3] = "Not Null!";
    values[5] = now;
    rowSetValues(row1, values);
    expect(cellGetValue(rowGetCell(row1, 1))).toBe(7);
    expect(cellGetValue(rowGetCell(row1, 2))).toBeNull();
    expect(cellGetValue(rowGetCell(row1, 3))).toBe("Not Null!");
    expect(cellType(rowGetCell(row1, 5))).toBe(Enums.ValueType.Date);
    expect(rowValues(row1)).toEqual([, 7, , "Not Null!", , now]);

    // set values by object
    rowSetValues(row1, {
      id: 9,
      name: "Dobbie",
      dob: now
    });
    expect(cellGetValue(rowGetCell(row1, 1))).toBe(9);
    expect(cellGetValue(rowGetCell(row1, 2))).toBe("Dobbie");
    expect(cellType(rowGetCell(row1, 3))).toBe(Enums.ValueType.Date);
    expect(cellGetValue(rowGetCell(row1, 5))).toBeNull();
    expect(rowValues(row1)).toEqual([, 9, "Dobbie", now]);
  });

  describe("Splice", () => {
    it("remove only", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);

      cellSetValue(rowGetCell(row, 2), 2);
      cellSetValue(rowGetCell(row, 3), 3);
      cellSetValue(rowGetCell(row, 5), 5);
      cellSetValue(rowGetCell(row, 7), 7);
      cellSetValue(rowGetCell(row, 11), "eleven");
      cellSetValue(rowGetCell(row, 13), 13);

      rowSplice(row, 3, 3);
      expect(cellGetValue(rowGetCell(row, 2))).toBe(2);
      expect(cellType(rowGetCell(row, 2))).toBe(Enums.ValueType.Number);
      expect(rowGetCell(row, 2).address).toBe("B1");
      expect(cellGetValue(rowGetCell(row, 4))).toBe(7);
      expect(cellType(rowGetCell(row, 4))).toBe(Enums.ValueType.Number);
      expect(rowGetCell(row, 4).address).toBe("D1");
      expect(cellGetValue(rowGetCell(row, 8))).toBe("eleven");
      expect(cellType(rowGetCell(row, 8))).toBe(Enums.ValueType.String);
      expect(rowGetCell(row, 8).address).toBe("H1");
    });

    it("remove to end", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);

      cellSetValue(rowGetCell(row, 1), 1);
      cellSetValue(rowGetCell(row, 2), 2);
      cellSetValue(rowGetCell(row, 3), 3);
      cellSetValue(rowGetCell(row, 4), 4);
      cellSetValue(rowGetCell(row, 5), 5);

      rowSplice(row, 4, 2);
      expect(cellGetValue(rowGetCell(row, 1))).toBe(1);
      expect(cellGetValue(rowGetCell(row, 2))).toBe(2);
      expect(cellGetValue(rowGetCell(row, 3))).toBe(3);
      expect(cellGetValue(rowGetCell(row, 4))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 5))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 6))).toBeNull();
    });

    it("remove almost to end", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);

      cellSetValue(rowGetCell(row, 1), 1);
      cellSetValue(rowGetCell(row, 2), 2);
      cellSetValue(rowGetCell(row, 3), 3);
      cellSetValue(rowGetCell(row, 4), 4);
      cellSetValue(rowGetCell(row, 5), 5);
      cellSetValue(rowGetCell(row, 6), 6);

      rowSplice(row, 4, 2);
      expect(cellGetValue(rowGetCell(row, 1))).toBe(1);
      expect(cellGetValue(rowGetCell(row, 2))).toBe(2);
      expect(cellGetValue(rowGetCell(row, 3))).toBe(3);
      expect(cellGetValue(rowGetCell(row, 4))).toBe(6);
      expect(cellGetValue(rowGetCell(row, 5))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 6))).toBeNull();
    });

    it("remove past end", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);

      cellSetValue(rowGetCell(row, 1), 1);
      cellSetValue(rowGetCell(row, 2), 2);
      cellSetValue(rowGetCell(row, 3), 3);
      cellSetValue(rowGetCell(row, 4), 4);
      cellSetValue(rowGetCell(row, 5), 5);
      cellSetValue(rowGetCell(row, 6), 6);

      rowSplice(row, 4, 4);
      expect(cellGetValue(rowGetCell(row, 1))).toBe(1);
      expect(cellGetValue(rowGetCell(row, 2))).toBe(2);
      expect(cellGetValue(rowGetCell(row, 3))).toBe(3);
      expect(cellGetValue(rowGetCell(row, 4))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 5))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 6))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 7))).toBeNull();
      expect(cellGetValue(rowGetCell(row, 8))).toBeNull();
    });

    it("remove and insert fewer", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);
      rowSetValues(row, [1, 2, 3, 4, 5, 6, 7, 8]);
      rowSplice(row, 4, 3, "four", "five");
      expect(rowValues(row)).toEqual([, 1, 2, 3, "four", "five", 7, 8]);
    });

    it("remove and insert replacements", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);
      rowSetValues(row, [1, 2, 3, 4, 5, 6, 7, 8]);
      rowSplice(row, 4, 3, "four", "five", "six");
      expect(rowValues(row)).toEqual([, 1, 2, 3, "four", "five", "six", 7, 8]);
    });

    it("remove and insert more", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);
      rowSetValues(row, [1, 2, 3, 4, 5, 6, 7, 8]);
      rowSplice(row, 4, 3, "four", "five", "six", "six and a half");
      expect(rowValues(row)).toEqual([, 1, 2, 3, "four", "five", "six", "six and a half", 7, 8]);
    });
  });

  it("iterates over cells", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);

    cellSetValue(rowGetCell(row1, 1), 1);
    cellSetValue(rowGetCell(row1, 2), 2);
    cellSetValue(rowGetCell(row1, 4), 4);
    cellSetValue(rowGetCell(row1, 6), 6);
    rowEachCell(row1, (cell: any, colNumber: any) => {
      expect(colNumber).not.toBe(3);
      expect(colNumber).not.toBe(5);
      expect(cellGetValue(cell)).toBe(colNumber);
    });

    let count = 1;
    rowEachCell(row1, { includeEmpty: true }, (cell: any, colNumber: any) => {
      expect(colNumber).toBe(count++);
    });
    expect(count).toBe(7);
  });

  it("exposes 0-based values helpers", () => {
    const sheet = testUtils.createSheetMock();
    const row = Worksheet.getRow(sheet, 1);

    rowSetValues(row, [1, 2, 3]);
    expect(rowValues(row)).toEqual([, 1, 2, 3]);

    expect(rowGetValues(row)).toEqual([1, 2, 3]);
    expect(rowValuesToString(row)).toBe("1,2,3");
    expect(rowValuesToString(row, "|")).toBe("1|2|3");

    // Sparse: only column 2 has a value
    const row2 = Worksheet.getRow(sheet, 2);
    cellSetValue(rowGetCell(row2, 2), 42);
    expect(rowValues(row2)).toEqual([, , 42]);
    expect(rowGetValues(row2)).toEqual([, 42]);
    expect(rowValuesToString(row2)).toBe(",42");
  });

  it("builds a model", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    cellSetValue(rowGetCell(row1, 1), 5);
    cellSetValue(rowGetCell(row1, 2), "Hello, World!");
    cellSetValue(rowGetCell(row1, 4), {
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    });
    cellSetValue(rowGetCell(row1, 5), null);
    row1.height! = 50;

    expect(rowGetModel(row1)).toEqual({
      cells: [
        { address: "A1", type: Enums.ValueType.Number, value: 5, style: {} },
        {
          address: "B1",
          type: Enums.ValueType.String,
          value: "Hello, World!",
          style: {}
        },
        {
          address: "D1",
          type: Enums.ValueType.Hyperlink,
          text: "www.hyperlink.com",
          hyperlink: "http://www.hyperlink.com",
          style: {}
        },
        { address: "E1", type: Enums.ValueType.Null, style: {} }
      ],
      number: 1,
      min: 1,
      max: 5,
      height: 50,
      customHeight: undefined,
      hidden: false,
      style: {},
      outlineLevel: 0,
      collapsed: false
    });

    const row2 = Worksheet.getRow(sheet, 2);
    expect(rowGetModel(row2)).toBeNull();
    rowSetHidden(row2, true);
    expect(rowGetModel(row2)).toMatchObject({ number: 2, hidden: true, cells: [] });

    const row3 = Worksheet.getRow(sheet, 3);
    cellSetValue(rowGetCell(row3, 1), 5);
    rowSetOutlineLevel(row3, 1);
    expect(rowGetModel(row3)).toEqual({
      cells: [{ address: "A3", type: Enums.ValueType.Number, value: 5, style: {} }],
      number: 3,
      min: 1,
      max: 1,
      height: undefined,
      customHeight: undefined,
      hidden: false,
      style: {},
      outlineLevel: 1,
      collapsed: true
    });
  });

  it("builds model with height=0 (auto-height)", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    cellSetValue(rowGetCell(row1, 1), "Hello");
    row1.height! = 0;

    const model = rowGetModel(row1);
    expect(model).not.toBeNull();
    expect(model!.height).toBe(0);
    expect(model!.customHeight).toBeUndefined();
  });

  it("preserves height=0 through model setter", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    rowSetModel(row1, {
      cells: [{ address: "A1", type: Enums.ValueType.Number, value: 5 }],
      number: 1,
      min: 1,
      max: 1,
      height: 0
    } as RowModel);

    expect(row1.height!).toBe(0);
  });

  it("preserves customHeight through model round-trip", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    rowSetModel(row1, {
      cells: [{ address: "A1", type: Enums.ValueType.Number, value: 5 }],
      number: 1,
      min: 1,
      max: 1,
      height: 30,
      customHeight: true
    } as RowModel);

    expect(row1.height!).toBe(30);
    expect(row1.customHeight).toBe(true);

    const model = rowGetModel(row1);
    expect(model!.height).toBe(30);
    expect(model!.customHeight).toBe(true);
  });

  it("returns model for height=0 row without cells", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    row1.height! = 0;

    const model = rowGetModel(row1);
    expect(model).not.toBeNull();
    expect(model!.height).toBe(0);
    expect(model!.cells).toEqual([]);
  });

  it("clears customHeight when model has no customHeight", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    row1.customHeight = true;
    row1.height! = 30;

    // Set model without customHeight — should clear it
    rowSetModel(row1, {
      cells: [{ address: "A1", type: Enums.ValueType.Number, value: 5 }],
      number: 1,
      min: 1,
      max: 1,
      height: 20
    } as RowModel);

    expect(row1.height!).toBe(20);
    expect(row1.customHeight).toBeUndefined();
  });

  it("builds from model", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);
    rowSetModel(row1, {
      cells: [
        { address: "A1", type: Enums.ValueType.Number, value: 5 },
        { address: "B1", type: Enums.ValueType.String, value: "Hello, World!" },
        {
          address: "D1",
          type: Enums.ValueType.Hyperlink,
          text: "www.hyperlink.com",
          hyperlink: "http://www.hyperlink.com"
        }
      ],
      number: 1,
      min: 1,
      max: 4,
      height: 32.5
    } as RowModel);

    expect(rowDimensions(row1)).toEqual({ min: 1, max: 4 });
    expect(rowValues(row1)).toEqual([
      ,
      5,
      "Hello, World!",
      ,
      { hyperlink: "http://www.hyperlink.com", text: "www.hyperlink.com" }
    ]);
    expect(cellType(rowGetCell(row1, 1))).toBe(Enums.ValueType.Number);
    expect(cellGetValue(rowGetCell(row1, 1))).toBe(5);
    expect(cellType(rowGetCell(row1, 2))).toBe(Enums.ValueType.String);
    expect(cellGetValue(rowGetCell(row1, 2))).toBe("Hello, World!");
    expect(cellType(rowGetCell(row1, 4))).toBe(Enums.ValueType.Hyperlink);
    expect(cellGetValue(rowGetCell(row1, 4))).toEqual({
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    });
    expect(cellType(rowGetCell(row1, 5))).toBe(Enums.ValueType.Null);
    expect(row1.height! - 32.5).toBeLessThan(0.00000001);
  });

  it("counts cells", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = Worksheet.getRow(sheet, 1);

    cellSetValue(rowGetCell(row1, 1), "one");
    cellSetValue(rowGetCell(row1, 2), "two");
    cellSetValue(rowGetCell(row1, 4), "four");
    cellSetValue(rowGetCell(row1, 5), "five");

    expect(rowCellCount(row1)).toBe(5);
    expect(rowActualCellCount(row1)).toBe(4);
  });

  describe("style isolation", () => {
    it("mutating a cell border after Row.border(row) broadcast does not leak to other cells", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);
      cellSetValue(rowGetCell(row, 1), "A");
      cellSetValue(rowGetCell(row, 2), "B");

      rowSetBorder(row, { top: { style: "thin" }, bottom: { style: "thin" } });

      // Mutate A1's border sub-property
      cellBorder(rowGetCell(row, 1))!.top = { style: "thick" };

      expect(cellBorder(rowGetCell(row, 1))!.top).toEqual({ style: "thick" });
      expect(cellBorder(rowGetCell(row, 2))!.top).toEqual({ style: "thin" });
    });

    it("mutating a cell font after Row.font(row) broadcast does not leak to other cells", () => {
      const sheet = testUtils.createSheetMock();
      const row = Worksheet.getRow(sheet, 1);
      cellSetValue(rowGetCell(row, 1), "A");
      cellSetValue(rowGetCell(row, 2), "B");

      rowSetFont(row, { bold: true, size: 12 });

      cellFont(rowGetCell(row, 1))!.bold = false;

      expect(cellFont(rowGetCell(row, 1))!.bold).toBe(false);
      expect(cellFont(rowGetCell(row, 2))!.bold).toBe(true);
    });
  });
});
