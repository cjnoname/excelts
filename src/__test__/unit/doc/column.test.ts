import { describe, it, expect } from "vitest";
import { testUtils } from "../../utils/index.js";
import { Column } from "../../../doc/column.js";

describe("Column", () => {
  it("creates by defn", () => {
    const sheet = testUtils.createSheetMock();

    sheet.addColumn(1, {
      header: "Col 1",
      key: "id1",
      width: 10
    });

    expect(sheet.getColumn(1).header).toBe("Col 1");
    expect(sheet.getColumn(1).headers).toEqual(["Col 1"]);
    expect(sheet.getCell(1, 1).value).toBe("Col 1");
    expect(sheet.getColumn("id1")).toBe(sheet.getColumn(1));

    sheet.getRow(2).values = { id1: "Hello, World!" };
    expect(sheet.getCell(2, 1).value).toBe("Hello, World!");
  });

  it("maintains properties", () => {
    const sheet = testUtils.createSheetMock();

    const column = sheet.addColumn(1);

    column.key = "id1";
    expect(sheet._keys.id1).toBe(column);

    expect(column.number).toBe(1);
    expect(column.letter).toBe("A");

    column.header = "Col 1";
    expect(sheet.getColumn(1).header).toBe("Col 1");
    expect(sheet.getColumn(1).headers).toEqual(["Col 1"]);
    expect(sheet.getCell(1, 1).value).toBe("Col 1");

    column.header = ["Col A1", "Col A2"];
    expect(sheet.getColumn(1).header).toEqual(["Col A1", "Col A2"]);
    expect(sheet.getColumn(1).headers).toEqual(["Col A1", "Col A2"]);
    expect(sheet.getCell(1, 1).value).toBe("Col A1");
    expect(sheet.getCell(2, 1).value).toBe("Col A2");

    sheet.getRow(3).values = { id1: "Hello, World!" };
    expect(sheet.getCell(3, 1).value).toBe("Hello, World!");
  });

  it("creates model", () => {
    const sheet = testUtils.createSheetMock();

    sheet.addColumn(1, {
      header: "Col 1",
      key: "id1",
      width: 10
    });
    sheet.addColumn(2, {
      header: "Col 2",
      key: "name",
      width: 10
    });
    sheet.addColumn(3, {
      header: "Col 2",
      key: "dob",
      width: 10,
      outlineLevel: 1
    });

    const model = Column.toModel(sheet.columns);
    expect(model!.length).toBe(2);

    expect(model![0].width).toBe(10);
    expect(model![0].outlineLevel).toBe(0);
    expect(model![0].collapsed).toBe(false);

    expect(model![1].width).toBe(10);
    expect(model![1].outlineLevel).toBe(1);
    expect(model![1].collapsed).toBe(true);
  });

  it("gets column values", () => {
    const sheet = testUtils.createSheetMock();
    sheet.getCell(1, 1).value = "a";
    sheet.getCell(2, 1).value = "b";
    sheet.getCell(4, 1).value = "d";

    expect(sheet.getColumn(1).values).toEqual([, "a", "b", , "d"]);
  });
  it("sets column values", () => {
    const sheet = testUtils.createSheetMock();

    sheet.getColumn(1).values = [2, 3, 5, 7, 11];

    expect(sheet.getCell(1, 1).value).toBe(2);
    expect(sheet.getCell(2, 1).value).toBe(3);
    expect(sheet.getCell(3, 1).value).toBe(5);
    expect(sheet.getCell(4, 1).value).toBe(7);
    expect(sheet.getCell(5, 1).value).toBe(11);
    expect(sheet.getCell(6, 1).value).toBe(null);
  });
  it("sets sparse column values", () => {
    const sheet = testUtils.createSheetMock();
    const values = [];
    values[2] = 2;
    values[3] = 3;
    values[5] = 5;
    values[11] = 11;
    sheet.getColumn(1).values = values;

    expect(sheet.getCell(1, 1).value).toBe(null);
    expect(sheet.getCell(2, 1).value).toBe(2);
    expect(sheet.getCell(3, 1).value).toBe(3);
    expect(sheet.getCell(4, 1).value).toBe(null);
    expect(sheet.getCell(5, 1).value).toBe(5);
    expect(sheet.getCell(6, 1).value).toBe(null);
    expect(sheet.getCell(7, 1).value).toBe(null);
    expect(sheet.getCell(8, 1).value).toBe(null);
    expect(sheet.getCell(9, 1).value).toBe(null);
    expect(sheet.getCell(10, 1).value).toBe(null);
    expect(sheet.getCell(11, 1).value).toBe(11);
    expect(sheet.getCell(12, 1).value).toBe(null);
  });
  it("sets sparse column values", () => {
    const sheet = testUtils.createSheetMock();
    sheet.getColumn(1).values = [, , 2, 3, , 5, , 7, , , , 11];

    expect(sheet.getCell(1, 1).value).toBe(null);
    expect(sheet.getCell(2, 1).value).toBe(2);
    expect(sheet.getCell(3, 1).value).toBe(3);
    expect(sheet.getCell(4, 1).value).toBe(null);
    expect(sheet.getCell(5, 1).value).toBe(5);
    expect(sheet.getCell(6, 1).value).toBe(null);
    expect(sheet.getCell(7, 1).value).toBe(7);
    expect(sheet.getCell(8, 1).value).toBe(null);
    expect(sheet.getCell(9, 1).value).toBe(null);
    expect(sheet.getCell(10, 1).value).toBe(null);
    expect(sheet.getCell(11, 1).value).toBe(11);
    expect(sheet.getCell(12, 1).value).toBe(null);
  });
  it("sets default column width", () => {
    const sheet = testUtils.createSheetMock();

    sheet.addColumn(1, {
      header: "Col 1",
      key: "id1",
      style: {
        numFmt: "0.00%"
      }
    });
    sheet.addColumn(2, {
      header: "Col 2",
      key: "id2",
      style: {
        numFmt: "0.00%"
      },
      width: 10
    });
    sheet.getColumn(3).numFmt = "0.00%";

    const model = Column.toModel(sheet.columns);
    expect(model!.length).toBe(3);

    expect(model![0].width).toBe(9);

    expect(model![1].width).toBe(10);

    expect(model![2].width).toBe(9);
  });
});
