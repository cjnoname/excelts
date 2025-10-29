import { describe, it, expect } from "vitest";
import { testUtils } from "../../utils/index.js";
import { Enums } from "../../../doc/enums.js";

describe("Row", () => {
  it("stores cells", () => {
    const sheet = testUtils.createSheetMock();
    sheet.addColumn(1, { key: "name" });

    const row1 = sheet.getRow(1);
    expect(row1.number).toBe(1);
    expect(row1.hasValues).not.toBeTruthy();

    const a1 = row1.getCell(1);
    expect(a1.address).toBe("A1");
    expect(a1.type).toBe(Enums.ValueType.Null);
    expect(row1.hasValues).not.toBeTruthy();

    expect(row1.getCell("A")).toBe(a1);
    expect(row1.getCell("name")).toBe(a1);

    a1.value = 5;
    expect(a1.type).toBe(Enums.ValueType.Number);
    expect(row1.hasValues).toBeTruthy();

    const b1 = row1.getCell(2);
    expect(b1.address).toBe("B1");
    expect(b1.type).toBe(Enums.ValueType.Null);
    expect(a1.type).toBe(Enums.ValueType.Number);

    b1.value = "Hello, World!";
    const d1 = row1.getCell(4);
    d1.value = {
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    };

    const values = [
      ,
      5,
      "Hello, World!",
      ,
      { hyperlink: "http://www.hyperlink.com", text: "www.hyperlink.com" }
    ];
    expect(row1.values).toEqual(values);
    expect(row1.dimensions).toEqual({ min: 1, max: 4 });

    let count = 0;
    row1.eachCell((cell: any, colNumber: any) => {
      expect(cell.type).not.toBe(Enums.ValueType.Null);
      switch (cell.type) {
        case Enums.ValueType.Hyperlink:
          expect(cell.value).toEqual(values[colNumber]);
          break;
        default:
          expect(cell.value).toBe(values[colNumber]);
          break;
      }
      count++;
    });

    // eachCell should just cover non-null cells
    expect(count).toBe(3);

    const row2 = sheet.getRow(2);
    expect(row2.dimensions).toBeNull();
  });

  it("stores values by whole row", () => {
    const sheet = testUtils.createSheetMock();
    sheet.addColumn(1, { key: "id" });
    sheet.addColumn(2, { key: "name" });
    sheet.addColumn(3, { key: "dob" });

    const now = new Date();

    const row1 = sheet.getRow(1);

    // set values by contiguous array
    row1.values = [5, "Hello, World!", null];
    expect(row1.getCell(1).value).toBe(5);
    expect(row1.getCell(2).value).toBe("Hello, World!");
    expect(row1.getCell(3).value).toBeNull();
    expect(row1.values).toEqual([, 5, "Hello, World!"]);

    // set values by sparse array
    const values: any[] = [];
    values[1] = 7;
    values[3] = "Not Null!";
    values[5] = now;
    row1.values = values;
    expect(row1.getCell(1).value).toBe(7);
    expect(row1.getCell(2).value).toBeNull();
    expect(row1.getCell(3).value).toBe("Not Null!");
    expect(row1.getCell(5).type).toBe(Enums.ValueType.Date);
    expect(row1.values).toEqual([, 7, , "Not Null!", , now]);

    // set values by object
    row1.values = {
      id: 9,
      name: "Dobbie",
      dob: now
    };
    expect(row1.getCell(1).value).toBe(9);
    expect(row1.getCell(2).value).toBe("Dobbie");
    expect(row1.getCell(3).type).toBe(Enums.ValueType.Date);
    expect(row1.getCell(5).value).toBeNull();
    expect(row1.values).toEqual([, 9, "Dobbie", now]);
  });

  describe("Splice", () => {
    it("remove only", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);

      row.getCell(2).value = 2;
      row.getCell(3).value = 3;
      row.getCell(5).value = 5;
      row.getCell(7).value = 7;
      row.getCell(11).value = "eleven";
      row.getCell(13).value = 13;

      row.splice(3, 3);
      expect(row.getCell(2).value).toBe(2);
      expect(row.getCell(2).type).toBe(Enums.ValueType.Number);
      expect(row.getCell(2).address).toBe("B1");
      expect(row.getCell(4).value).toBe(7);
      expect(row.getCell(4).type).toBe(Enums.ValueType.Number);
      expect(row.getCell(4).address).toBe("D1");
      expect(row.getCell(8).value).toBe("eleven");
      expect(row.getCell(8).type).toBe(Enums.ValueType.String);
      expect(row.getCell(8).address).toBe("H1");
    });

    it("remove to end", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);

      row.getCell(1).value = 1;
      row.getCell(2).value = 2;
      row.getCell(3).value = 3;
      row.getCell(4).value = 4;
      row.getCell(5).value = 5;

      row.splice(4, 2);
      expect(row.getCell(1).value).toBe(1);
      expect(row.getCell(2).value).toBe(2);
      expect(row.getCell(3).value).toBe(3);
      expect(row.getCell(4).value).toBeNull();
      expect(row.getCell(5).value).toBeNull();
      expect(row.getCell(6).value).toBeNull();
    });

    it("remove almost to end", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);

      row.getCell(1).value = 1;
      row.getCell(2).value = 2;
      row.getCell(3).value = 3;
      row.getCell(4).value = 4;
      row.getCell(5).value = 5;
      row.getCell(6).value = 6;

      row.splice(4, 2);
      expect(row.getCell(1).value).toBe(1);
      expect(row.getCell(2).value).toBe(2);
      expect(row.getCell(3).value).toBe(3);
      expect(row.getCell(4).value).toBe(6);
      expect(row.getCell(5).value).toBeNull();
      expect(row.getCell(6).value).toBeNull();
    });

    it("remove past end", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);

      row.getCell(1).value = 1;
      row.getCell(2).value = 2;
      row.getCell(3).value = 3;
      row.getCell(4).value = 4;
      row.getCell(5).value = 5;
      row.getCell(6).value = 6;

      row.splice(4, 4);
      expect(row.getCell(1).value).toBe(1);
      expect(row.getCell(2).value).toBe(2);
      expect(row.getCell(3).value).toBe(3);
      expect(row.getCell(4).value).toBeNull();
      expect(row.getCell(5).value).toBeNull();
      expect(row.getCell(6).value).toBeNull();
      expect(row.getCell(7).value).toBeNull();
      expect(row.getCell(8).value).toBeNull();
    });

    it("remove and insert fewer", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);
      row.values = [1, 2, 3, 4, 5, 6, 7, 8];
      row.splice(4, 3, "four", "five");
      expect(row.values).toEqual([, 1, 2, 3, "four", "five", 7, 8]);
    });

    it("remove and insert replacements", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);
      row.values = [1, 2, 3, 4, 5, 6, 7, 8];
      row.splice(4, 3, "four", "five", "six");
      expect(row.values).toEqual([, 1, 2, 3, "four", "five", "six", 7, 8]);
    });

    it("remove and insert more", () => {
      const sheet = testUtils.createSheetMock();
      const row = sheet.getRow(1);
      row.values = [1, 2, 3, 4, 5, 6, 7, 8];
      row.splice(4, 3, "four", "five", "six", "six and a half");
      expect(row.values).toEqual([, 1, 2, 3, "four", "five", "six", "six and a half", 7, 8]);
    });
  });

  it("iterates over cells", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = sheet.getRow(1);

    row1.getCell(1).value = 1;
    row1.getCell(2).value = 2;
    row1.getCell(4).value = 4;
    row1.getCell(6).value = 6;
    row1.eachCell((cell: any, colNumber: any) => {
      expect(colNumber).not.toBe(3);
      expect(colNumber).not.toBe(5);
      expect(cell.value).toBe(colNumber);
    });

    let count = 1;
    row1.eachCell({ includeEmpty: true }, (cell: any, colNumber: any) => {
      expect(colNumber).toBe(count++);
    });
    expect(count).toBe(7);
  });

  it("builds a model", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = sheet.getRow(1);
    row1.getCell(1).value = 5;
    row1.getCell(2).value = "Hello, World!";
    row1.getCell(4).value = {
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    };
    row1.getCell(5).value = null;
    row1.height = 50;

    expect(row1.model).toEqual({
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
      hidden: false,
      style: {},
      outlineLevel: 0,
      collapsed: false
    });

    const row2 = sheet.getRow(2);
    expect(row2.model).toBeNull();

    const row3 = sheet.getRow(3);
    row3.getCell(1).value = 5;
    row3.outlineLevel = 1;
    expect(row3.model).toEqual({
      cells: [{ address: "A3", type: Enums.ValueType.Number, value: 5, style: {} }],
      number: 3,
      min: 1,
      max: 1,
      height: undefined,
      hidden: false,
      style: {},
      outlineLevel: 1,
      collapsed: true
    });
  });

  it("builds from model", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = sheet.getRow(1);
    row1.model = {
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
    };

    expect(row1.dimensions).toEqual({ min: 1, max: 4 });
    expect(row1.values).toEqual([
      ,
      5,
      "Hello, World!",
      ,
      { hyperlink: "http://www.hyperlink.com", text: "www.hyperlink.com" }
    ]);
    expect(row1.getCell(1).type).toBe(Enums.ValueType.Number);
    expect(row1.getCell(1).value).toBe(5);
    expect(row1.getCell(2).type).toBe(Enums.ValueType.String);
    expect(row1.getCell(2).value).toBe("Hello, World!");
    expect(row1.getCell(4).type).toBe(Enums.ValueType.Hyperlink);
    expect(row1.getCell(4).value).toEqual({
      hyperlink: "http://www.hyperlink.com",
      text: "www.hyperlink.com"
    });
    expect(row1.getCell(5).type).toBe(Enums.ValueType.Null);
    expect(row1.height - 32.5).toBeLessThan(0.00000001);
  });

  it("counts cells", () => {
    const sheet = testUtils.createSheetMock();
    const row1 = sheet.getRow(1);

    row1.getCell(1).value = "one";
    row1.getCell(2).value = "two";
    row1.getCell(4).value = "four";
    row1.getCell(5).value = "five";

    expect(row1.cellCount).toBe(5);
    expect(row1.actualCellCount).toBe(4);
  });
});
