import { describe, it, expect } from "vitest";
import path from "path";
import { testUtils } from "../utils/index.js";
import { ValueType, Workbook } from "../../index.js";
import { Range } from "../../doc/range.js";

describe("Worksheet", () => {
  describe("Values", () => {
    it("stores values properly", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const now = new Date();

      // plain number
      ws.getCell("A1").value = 7;

      // simple string
      ws.getCell("B1").value = "Hello, World!";

      // floating point
      ws.getCell("C1").value = 3.14;

      // 5 will be overwritten by the current date-time
      ws.getCell("D1").value = 5;
      ws.getCell("D1").value = now;

      // constructed string - will share recored with B1
      ws.getCell("E1").value = `${["Hello", "World"].join(", ")}!`;

      // hyperlink
      ws.getCell("F1").value = {
        text: "www.google.com",
        hyperlink: "http://www.google.com"
      };

      // number formula
      ws.getCell("A2").value = { formula: "A1", result: 7 };

      // string formula
      ws.getCell("B2").value = {
        formula: 'CONCATENATE("Hello", ", ", "World!")',
        result: "Hello, World!"
      };

      // date formula
      ws.getCell("C2").value = { formula: "D1", result: now };

      expect(ws.getCell("A1").value).toBe(7);
      expect(ws.getCell("B1").value).toBe("Hello, World!");
      expect(ws.getCell("C1").value).toBe(3.14);
      expect(ws.getCell("D1").value).toBe(now);
      expect(ws.getCell("E1").value).toBe("Hello, World!");
      expect(ws.getCell("F1").value.text).toBe("www.google.com");
      expect(ws.getCell("F1").value.hyperlink).toBe("http://www.google.com");

      expect(ws.getCell("A2").value.formula).toBe("A1");
      expect(ws.getCell("A2").value.result).toBe(7);

      expect(ws.getCell("B2").value.formula).toBe('CONCATENATE("Hello", ", ", "World!")');
      expect(ws.getCell("B2").value.result).toBe("Hello, World!");

      expect(ws.getCell("C2").value.formula).toBe("D1");
      expect(ws.getCell("C2").value.result).toBe(now);
    });

    it("stores shared string values properly", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.getCell("A1").value = "Hello, World!";

      ws.getCell("A2").value = "Hello";
      ws.getCell("B2").value = "World";
      ws.getCell("C2").value = {
        formula: 'CONCATENATE(A2, ", ", B2, "!")',
        result: "Hello, World!"
      };

      ws.getCell("A3").value = `${["Hello", "World"].join(", ")}!`;

      // A1 and A3 should reference the same string object
      expect(ws.getCell("A1").value).toBe(ws.getCell("A3").value);

      // A1 and C2 should not reference the same object
      expect(ws.getCell("A1").value).toBe(ws.getCell("C2").value.result);
    });

    it("assigns cell types properly", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // plain number
      ws.getCell("A1").value = 7;

      // simple string
      ws.getCell("B1").value = "Hello, World!";

      // floating point
      ws.getCell("C1").value = 3.14;

      // date-time
      ws.getCell("D1").value = new Date();

      // hyperlink
      ws.getCell("E1").value = {
        text: "www.google.com",
        hyperlink: "http://www.google.com"
      };

      // number formula
      ws.getCell("A2").value = { formula: "A1", result: 7 };

      // string formula
      ws.getCell("B2").value = {
        formula: 'CONCATENATE("Hello", ", ", "World!")',
        result: "Hello, World!"
      };

      // date formula
      ws.getCell("C2").value = { formula: "D1", result: new Date() };

      expect(ws.getCell("A1").type).toBe(ValueType.Number);
      expect(ws.getCell("B1").type).toBe(ValueType.String);
      expect(ws.getCell("C1").type).toBe(ValueType.Number);
      expect(ws.getCell("D1").type).toBe(ValueType.Date);
      expect(ws.getCell("E1").type).toBe(ValueType.Hyperlink);

      expect(ws.getCell("A2").type).toBe(ValueType.Formula);
      expect(ws.getCell("B2").type).toBe(ValueType.Formula);
      expect(ws.getCell("C2").type).toBe(ValueType.Formula);
    });

    it("adds columns", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.columns = [
        { key: "id", width: 10 },
        { key: "name", width: 32 },
        { key: "dob", width: 10 }
      ];

      expect(ws.getColumn("id").number).toBe(1);
      expect(ws.getColumn("id").width).toBe(10);
      expect(ws.getColumn("A")).toBe(ws.getColumn("id"));
      expect(ws.getColumn(1)).toBe(ws.getColumn("id"));

      expect(ws.getColumn("name").number).toBe(2);
      expect(ws.getColumn("name").width).toBe(32);
      expect(ws.getColumn("B")).toBe(ws.getColumn("name"));
      expect(ws.getColumn(2)).toBe(ws.getColumn("name"));

      expect(ws.getColumn("dob").number).toBe(3);
      expect(ws.getColumn("dob").width).toBe(10);
      expect(ws.getColumn("C")).toBe(ws.getColumn("dob"));
      expect(ws.getColumn(3)).toBe(ws.getColumn("dob"));
    });

    it("adds column headers", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.columns = [
        { header: "Id", width: 10 },
        { header: "Name", width: 32 },
        { header: "D.O.B.", width: 10 }
      ];

      expect(ws.getCell("A1").value).toBe("Id");
      expect(ws.getCell("B1").value).toBe("Name");
      expect(ws.getCell("C1").value).toBe("D.O.B.");
    });

    it("adds column headers by number", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // by defn
      ws.getColumn(1).defn = { key: "id", header: "Id", width: 10 };

      // by property
      ws.getColumn(2).key = "name";
      ws.getColumn(2).header = "Name";
      ws.getColumn(2).width = 32;

      expect(ws.getCell("A1").value).toBe("Id");
      expect(ws.getCell("B1").value).toBe("Name");

      expect(ws.getColumn("A").key).toBe("id");
      expect(ws.getColumn(1).key).toBe("id");
      expect(ws.getColumn(1).header).toBe("Id");
      expect(ws.getColumn(1).headers).toEqual(["Id"]);
      expect(ws.getColumn(1).width).toBe(10);

      expect(ws.getColumn(2).key).toBe("name");
      expect(ws.getColumn(2).header).toBe("Name");
      expect(ws.getColumn(2).headers).toEqual(["Name"]);
      expect(ws.getColumn(2).width).toBe(32);
    });

    it("adds column headers by letter", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // by defn
      ws.getColumn("A").defn = { key: "id", header: "Id", width: 10 };

      // by property
      ws.getColumn("B").key = "name";
      ws.getColumn("B").header = "Name";
      ws.getColumn("B").width = 32;

      expect(ws.getCell("A1").value).toBe("Id");
      expect(ws.getCell("B1").value).toBe("Name");

      expect(ws.getColumn("A").key).toBe("id");
      expect(ws.getColumn(1).key).toBe("id");
      expect(ws.getColumn("A").header).toBe("Id");
      expect(ws.getColumn("A").headers).toEqual(["Id"]);
      expect(ws.getColumn("A").width).toBe(10);

      expect(ws.getColumn("B").key).toBe("name");
      expect(ws.getColumn("B").header).toBe("Name");
      expect(ws.getColumn("B").headers).toEqual(["Name"]);
      expect(ws.getColumn("B").width).toBe(32);
    });

    it("adds rows by object", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // add columns to define column keys
      ws.columns = [
        { header: "Id", key: "id", width: 10 },
        { header: "Name", key: "name", width: 32 },
        { header: "D.O.B.", key: "dob", width: 10 }
      ];

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);

      ws.addRow({ id: 1, name: "John Doe", dob: dateValue1 });
      ws.addRow({ id: 2, name: "Jane Doe", dob: dateValue2 });

      expect(ws.getCell("A2").value).toBe(1);
      expect(ws.getCell("B2").value).toBe("John Doe");
      expect(ws.getCell("C2").value).toBe(dateValue1);

      expect(ws.getCell("A3").value).toBe(2);
      expect(ws.getCell("B3").value).toBe("Jane Doe");
      expect(ws.getCell("C3").value).toBe(dateValue2);

      expect(ws.getRow(2).values).toEqual([undefined, 1, "John Doe", dateValue1]);
      expect(ws.getRow(3).values).toEqual([undefined, 2, "Jane Doe", dateValue2]);

      const values = [
        ,
        [, "Id", "Name", "D.O.B."],
        [, 1, "John Doe", dateValue1],
        [, 2, "Jane Doe", dateValue2]
      ];
      ws.eachRow((row, rowNumber) => {
        expect(row.values).toEqual(values[rowNumber]);
        row.eachCell((cell, colNumber) => {
          expect(cell.value).toBe(values[rowNumber]![colNumber]);
        });
      });

      const fetchedRows = ws.getRows(1, 2);
      for (let i = 0; i < 2; i++) {
        expect(fetchedRows![i].values).toEqual(values[i + 1]);
      }
    });

    it("adds rows by contiguous array", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);

      ws.addRow([1, "John Doe", dateValue1]);
      ws.addRow([2, "Jane Doe", dateValue2]);

      expect(ws.getCell("A1").value).toBe(1);
      expect(ws.getCell("B1").value).toBe("John Doe");
      expect(ws.getCell("C1").value).toBe(dateValue1);

      expect(ws.getCell("A2").value).toBe(2);
      expect(ws.getCell("B2").value).toBe("Jane Doe");
      expect(ws.getCell("C2").value).toBe(dateValue2);

      expect(ws.getRow(1).values).toEqual([undefined, 1, "John Doe", dateValue1]);
      expect(ws.getRow(2).values).toEqual([undefined, 2, "Jane Doe", dateValue2]);

      const values = [
        [, 1, "John Doe", dateValue1],
        [, 2, "Jane Doe", dateValue2]
      ];
      const fetchedRows = ws.getRows(1, 2);
      for (let i = 0; i < 2; i++) {
        expect(fetchedRows![i].values).toEqual(values[i]);
      }
    });

    it("adds rows by sparse array", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);
      const rows = [, [, 1, "John Doe", , dateValue1], [, 2, "Jane Doe", , dateValue2]];
      const row3 = [];
      row3[1] = 3;
      row3[3] = "Sam";
      row3[5] = dateValue1;
      rows.push(row3);
      rows.forEach(row => {
        if (row) {
          ws.addRow(row);
        }
      });

      expect(ws.getCell("A1").value).toBe(1);
      expect(ws.getCell("B1").value).toBe("John Doe");
      expect(ws.getCell("D1").value).toBe(dateValue1);

      expect(ws.getCell("A2").value).toBe(2);
      expect(ws.getCell("B2").value).toBe("Jane Doe");
      expect(ws.getCell("D2").value).toBe(dateValue2);

      expect(ws.getCell("A3").value).toBe(3);
      expect(ws.getCell("C3").value).toBe("Sam");
      expect(ws.getCell("E3").value).toBe(dateValue1);

      expect(ws.getRow(1).values).toEqual(rows[1]);
      expect(ws.getRow(2).values).toEqual(rows[2]);
      expect(ws.getRow(3).values).toEqual(rows[3]);

      ws.eachRow((row, rowNumber) => {
        expect(row.values).toEqual(rows[rowNumber]);
        row.eachCell((cell: any, colNumber: any) => {
          expect(cell.value).toBe(rows[rowNumber]![colNumber]);
        });
      });

      const fetchedRows = ws.getRows(1, 2);
      for (let i = 0; i < 2; i++) {
        expect(fetchedRows![i].values).toEqual(rows[i + 1]);
      }
    });

    it("adds rows with style option", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);

      ws.addRow([1, "John Doe", dateValue1]);
      ws.getRow(1).font = testUtils.styles.fonts.comicSansUdB16;
      ws.addRow([2, "Jane Doe", dateValue2], "i");
      ws.addRow([3, "Jane Doe", dateValue2], "n");
      ws.addRow([4, "Jane Doe", dateValue2], "i");

      expect(ws.getCell("A1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A2").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A3").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A4").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
    });

    it("inserts rows by object", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // add columns to define column keys
      ws.columns = [
        { header: "Id", key: "id", width: 10 },
        { header: "Name", key: "name", width: 32 },
        { header: "D.O.B.", key: "dob", width: 10 }
      ];

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);
      const dateValue3 = new Date(1965, 1, 10);

      ws.addRow({ id: 1, name: "John Doe", dob: dateValue1 });
      ws.addRow({ id: 2, name: "Jane Doe", dob: dateValue2 });

      // insert in 3 shifting down earlier
      ws.insertRow(3, { id: 3, name: "Other Doe", dob: dateValue3 });

      expect(ws.getCell("A2").value).toBe(1);
      expect(ws.getCell("B2").value).toBe("John Doe");
      expect(ws.getCell("C2").value).toBe(dateValue1);

      expect(ws.getCell("A3").value).toBe(3);
      expect(ws.getCell("B3").value).toBe("Other Doe");
      expect(ws.getCell("C3").value).toBe(dateValue3);

      expect(ws.getCell("A4").value).toBe(2);
      expect(ws.getCell("B4").value).toBe("Jane Doe");
      expect(ws.getCell("C4").value).toBe(dateValue2);

      const values = [
        ,
        [, "Id", "Name", "D.O.B."],
        [, 1, "John Doe", dateValue1],
        [, 3, "Other Doe", dateValue3],
        [, 2, "Jane Doe", dateValue2]
      ];
      ws.eachRow((row, rowNumber) => {
        expect(row.values).toEqual(values[rowNumber]);
        row.eachCell((cell: any, colNumber: any) => {
          expect(cell.value).toBe(values[rowNumber]![colNumber]);
        });
      });

      const fetchedRows = ws.getRows(1, 2);
      for (let i = 0; i < 2; i++) {
        expect(fetchedRows![i].values).toEqual(values[i + 1]);
      }
    });

    it("inserts rows by contiguous array", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);
      const dateValue3 = new Date(1965, 1, 10);

      ws.addRow([1, "John Doe", dateValue1]);
      ws.addRow([2, "Jane Doe", dateValue2]);

      // insert in 2 shifting down earlier
      ws.insertRow(2, [3, "Other Doe", dateValue3]);

      expect(ws.getCell("A1").value).toBe(1);
      expect(ws.getCell("B1").value).toBe("John Doe");
      expect(ws.getCell("C1").value).toBe(dateValue1);

      expect(ws.getCell("A2").value).toBe(3);
      expect(ws.getCell("B2").value).toBe("Other Doe");
      expect(ws.getCell("C2").value).toBe(dateValue3);

      expect(ws.getCell("A3").value).toBe(2);
      expect(ws.getCell("B3").value).toBe("Jane Doe");
      expect(ws.getCell("C3").value).toBe(dateValue2);

      const values: any = [
        [, 1, "John Doe", dateValue1],
        [, 3, "Other Doe", dateValue3],
        [, 2, "Jane Doe", dateValue2]
      ];

      expect(ws.getRow(1).values).toEqual(values[0]);
      expect(ws.getRow(2).values).toEqual(values[1]);
      expect(ws.getRow(3).values).toEqual(values[2]);

      const fetchedRows = ws.getRows(1, 3);
      for (let i = 0; i < 3; i++) {
        expect(fetchedRows![i].values).toEqual(values[i]);
      }
    });

    it("inserts rows by sparse array", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);
      const dateValue3 = new Date(1965, 1, 10);
      const rows: any = [, [, 1, "John Doe", , dateValue1], [, 2, "Jane Doe", , dateValue2]];
      const row3 = [];
      row3[1] = 3;
      row3[3] = "Other Doe";
      row3[5] = dateValue3;
      rows.push(row3);
      rows.forEach(row => {
        if (row) {
          // insert on row 1 every time and thus finally reversed order
          ws.insertRow(1, row);
        }
      });

      expect(ws.getCell("A1").value).toBe(3);
      expect(ws.getCell("C1").value).toBe("Other Doe");
      expect(ws.getCell("E1").value).toBe(dateValue3);

      expect(ws.getCell("A2").value).toBe(2);
      expect(ws.getCell("B2").value).toBe("Jane Doe");
      expect(ws.getCell("D2").value).toBe(dateValue2);

      expect(ws.getCell("A3").value).toBe(1);
      expect(ws.getCell("B3").value).toBe("John Doe");
      expect(ws.getCell("D3").value).toBe(dateValue1);

      ws.eachRow((row, rowNumber) => {
        expect(row.values).toEqual(rows[rows.length - rowNumber]);
        row.eachCell((cell: any, colNumber: any) => {
          expect(cell.value).toBe(rows[rows.length - rowNumber]![colNumber]);
        });
      });

      const fetchedRows = ws.getRows(1, 3);
      for (let i = 0; i < 3; i++) {
        expect(fetchedRows![i].values).toEqual(rows[rows.length - i - 1]);
      }
    });

    it("inserts rows with style option", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);

      const arr = [
        [5, "Jane Doe", dateValue2],
        [5, "Jane Doe", dateValue2],
        [5, "Jane Doe", dateValue2]
      ];

      ws.addRow([5, "John Doe", dateValue1]);
      ws.getRow(1).font = testUtils.styles.fonts.comicSansUdB16;

      ws.insertRow(1, [5, "Jane Doe", dateValue2], "o");
      ws.insertRow(1, [4, "Jane Doe", dateValue2], "i");
      ws.insertRow(1, [3, "Jane Doe", dateValue2], "n");
      ws.insertRow(1, [2, "Jane Doe", dateValue2], "o");

      ws.addRow([6, "Jane Doe", dateValue2]);
      ws.getRow(6).font = testUtils.styles.fonts.comicSansUdB16;

      ws.insertRows(6, arr, "o");
      ws.insertRows(10, arr, "i");
      ws.insertRows(13, arr);

      expect(ws.getCell("A1").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A2").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A3").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A4").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A5").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A6").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A9").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      for (let i = 7; i <= 8; i++) {
        expect(ws.getCell(`A${i}`).font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      }
      for (let i = 10; i <= 12; i++) {
        expect(ws.getCell(`A${i}`).font).toEqual(testUtils.styles.fonts.comicSansUdB16);
      }
      for (let i = 13; i <= 15; i++) {
        expect(ws.getCell(`A${i}`).font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      }
    });

    it("should style of the inserted row with inherited style be mutable", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const dateValue1 = new Date(1970, 1, 1);
      const dateValue2 = new Date(1965, 1, 7);

      ws.addRow([1, "John Doe", dateValue1]);
      ws.getRow(1).font = testUtils.styles.fonts.comicSansUdB16;

      ws.insertRow(2, [3, "Jane Doe", dateValue2], "i");
      ws.insertRow(2, [2, "Jane Doe", dateValue2], "o");

      ws.getRow(2).font = testUtils.styles.fonts.broadwayRedOutline20;
      ws.getRow(3).font = testUtils.styles.fonts.broadwayRedOutline20;
      ws.getCell("A2").font = testUtils.styles.fonts.arialBlackUI14;
      ws.getCell("A3").font = testUtils.styles.fonts.arialBlackUI14;

      expect(ws.getRow(2).font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getRow(3).font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A2").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
      expect(ws.getCell("A3").font).not.deep.equal(testUtils.styles.fonts.comicSansUdB16);
    });

    it("iterates over rows", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.getCell("A1").value = 1;
      ws.getCell("B2").value = 2;
      ws.getCell("D4").value = 4;
      ws.getCell("F6").value = 6;
      ws.eachRow((row, rowNumber) => {
        expect(rowNumber).not.toBe(3);
        expect(rowNumber).not.toBe(5);
      });

      let count = 1;
      ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        expect(rowNumber).toBe(count++);
      });
    });

    it("iterates over collumn cells", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.getCell("A1").value = 1;
      ws.getCell("A2").value = 2;
      ws.getCell("A4").value = 4;
      ws.getCell("A6").value = 6;
      const colA = ws.getColumn("A");
      colA.eachCell((cell: any, rowNumber: any) => {
        expect(rowNumber).not.toBe(3);
        expect(rowNumber).not.toBe(5);
        expect(cell.value).toBe(rowNumber);
      });

      let count = 1;
      colA.eachCell({ includeEmpty: true }, (cell: any, rowNumber: any) => {
        expect(rowNumber).toBe(count++);
      });
      expect(count).toBe(7);
    });

    it("returns undefined when row range is less than 1", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      expect(ws.getRows(1, 0)).toBe(undefined);
    });
    describe("when worksheet name is less than or equal 31", () => {
      it("save the original name", () => {
        const wb = new Workbook();
        let ws = wb.addWorksheet();
        ws.name = "ThisIsAWorksheetName";
        expect(ws.name).toBe("ThisIsAWorksheetName");

        ws = wb.addWorksheet();
        ws.name = "ThisIsAWorksheetNameWith31Chars";
        expect(ws.name).toBe("ThisIsAWorksheetNameWith31Chars");
      });
    });

    describe("name is be not empty string", () => {
      it("when empty should thrown an error", () => {
        const wb = new Workbook();

        expect(() => {
          const ws = wb.addWorksheet();
          ws.name = "";
        }).toThrow("The name can't be empty.");
      });
    });

    describe("when worksheet name is `History`", () => {
      it("thrown an error", () => {
        const wb = new Workbook();

        expect(() => {
          const ws = wb.addWorksheet();
          ws.name = "History";
        }).toThrow('The name "History" is protected. Please use a different name.');
      });
    });

    describe("when worksheet name is longer than 31", () => {
      it("keep first 31 characters", () => {
        const wb = new Workbook();
        const ws = wb.addWorksheet();
        ws.name = "ThisIsAWorksheetNameThatIsLongerThan31";

        expect(ws.name).toBe("ThisIsAWorksheetNameThatIsLonge");
      });
    });

    describe("when the worksheet name contains illegal characters", () => {
      it("throws an error", () => {
        const workbook = new Workbook();

        const invalidCharacters = ["*", "?", ":", "/", "\\", "[", "]"];

        for (const invalidCharacter of invalidCharacters) {
          expect(() => {
            const ws = workbook.addWorksheet();
            ws.name = invalidCharacter;
          }).toThrow(
            `Worksheet name ${invalidCharacter} cannot include any of the following characters: * ? : \\ / [ ]`
          );
        }
      });

      it("throws an error", () => {
        const workbook = new Workbook();

        const invalidNames = ["'sheetName", "sheetName'"];

        for (const invalidName of invalidNames) {
          expect(() => {
            const ws = workbook.addWorksheet();
            ws.name = invalidName;
          }).toThrow(
            `The first or last character of worksheet name cannot be a single quotation mark: ${invalidName}`
          );
        }
      });
    });

    describe("when worksheet name already exists", () => {
      it("throws an error", () => {
        const wb = new Workbook();

        const validName = "thisisaworksheetnameinuppercase";
        const invalideName = "THISISAWORKSHEETNAMEINUPPERCASE";
        const expectedError = `Worksheet name already exists: ${invalideName}`;

        const ws = wb.addWorksheet();
        ws.name = validName;

        expect(() => {
          const newWs = wb.addWorksheet();
          newWs.name = invalideName;
        }).toThrow(expectedError);
      });

      it("throws an error", () => {
        const wb = new Workbook();

        const validName = "ThisIsAWorksheetNameThatIsLonge";
        const invalideName = "ThisIsAWorksheetNameThatIsLongerThan31";
        const expectedError = `Worksheet name already exists: ${validName}`;

        const ws = wb.addWorksheet();
        ws.name = validName;

        expect(() => {
          const newWs = wb.addWorksheet();
          newWs.name = validName;
        }).toThrow(expectedError);

        expect(() => {
          const newWs = wb.addWorksheet();
          newWs.name = invalideName;
        }).toThrow(expectedError);
      });
    });
  });

  it("returns sheet values", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet();

    ws.getCell("A1").value = 11;
    ws.getCell("C1").value = "C1";
    ws.getCell("A2").value = 21;
    ws.getCell("B2").value = "B2";
    ws.getCell("A4").value = "end";

    expect(ws.getSheetValues()).toEqual([, [, 11, , "C1"], [, 21, "B2"], , [, "end"]] as any);
  });

  it("sets row styles", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("basket");

    ws.getCell("A1").value = 5;
    ws.getCell("A1").numFmt = testUtils.styles.numFmts.numFmt1;
    ws.getCell("A1").font = testUtils.styles.fonts.arialBlackUI14;

    ws.getCell("C1").value = "Hello, World!";
    ws.getCell("C1").alignment = testUtils.styles.namedAlignments.bottomRight;
    ws.getCell("C1").border = testUtils.styles.borders.doubleRed;
    ws.getCell("C1").fill = testUtils.styles.fills.redDarkVertical;

    ws.getRow(1).numFmt = testUtils.styles.numFmts.numFmt2;
    ws.getRow(1).font = testUtils.styles.fonts.comicSansUdB16;
    ws.getRow(1).alignment = testUtils.styles.namedAlignments.middleCentre;
    ws.getRow(1).border = testUtils.styles.borders.thin;
    ws.getRow(1).fill = testUtils.styles.fills.redGreenDarkTrellis;

    expect(ws.getCell("A1").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("A1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("A1").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("A1").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("A1").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);

    expect(ws.findCell("B1")).toBeUndefined();

    expect(ws.getCell("C1").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("C1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("C1").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("C1").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("C1").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);

    // when we 'get' the previously null cell, it should inherit the row styles
    expect(ws.getCell("B1").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("B1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("B1").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("B1").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("B1").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);
  });

  it("sets col styles", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("basket");

    ws.getCell("A1").value = 5;
    ws.getCell("A1").numFmt = testUtils.styles.numFmts.numFmt1;
    ws.getCell("A1").font = testUtils.styles.fonts.arialBlackUI14;

    ws.getCell("A3").value = "Hello, World!";
    ws.getCell("A3").alignment = testUtils.styles.namedAlignments.bottomRight;
    ws.getCell("A3").border = testUtils.styles.borders.doubleRed;
    ws.getCell("A3").fill = testUtils.styles.fills.redDarkVertical;

    ws.getColumn("A").numFmt = testUtils.styles.numFmts.numFmt2;
    ws.getColumn("A").font = testUtils.styles.fonts.comicSansUdB16;
    ws.getColumn("A").alignment = testUtils.styles.namedAlignments.middleCentre;
    ws.getColumn("A").border = testUtils.styles.borders.thin;
    ws.getColumn("A").fill = testUtils.styles.fills.redGreenDarkTrellis;

    expect(ws.getCell("A1").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("A1").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("A1").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("A1").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("A1").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);

    expect(ws.findRow(2)).toBeUndefined();

    expect(ws.getCell("A3").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("A3").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("A3").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("A3").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("A3").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);

    // when we 'get' the previously null cell, it should inherit the column styles
    expect(ws.getCell("A2").numFmt).toBe(testUtils.styles.numFmts.numFmt2);
    expect(ws.getCell("A2").font).toEqual(testUtils.styles.fonts.comicSansUdB16);
    expect(ws.getCell("A2").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
    expect(ws.getCell("A2").border).toEqual(testUtils.styles.borders.thin);
    expect(ws.getCell("A2").fill).toEqual(testUtils.styles.fills.redGreenDarkTrellis);
  });

  it("puts the lotion in the basket", () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet("basket");
    ws.getCell("A1").value = "lotion";
  });

  describe("Merge Cells", () => {
    it("references the same top-left value", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // initial values
      ws.getCell("A1").value = "A1";
      ws.getCell("B1").value = "B1";
      ws.getCell("A2").value = "A2";
      ws.getCell("B2").value = "B2";

      ws.mergeCells("A1:B2");

      expect(ws.getCell("A1").value).toBe("A1");
      expect(ws.getCell("B1").value).toBe("A1");
      expect(ws.getCell("A2").value).toBe("A1");
      expect(ws.getCell("B2").value).toBe("A1");

      expect(ws.getCell("A1").type).toBe(ValueType.String);
      expect(ws.getCell("B1").type).toBe(ValueType.Merge);
      expect(ws.getCell("A2").type).toBe(ValueType.Merge);
      expect(ws.getCell("B2").type).toBe(ValueType.Merge);
    });

    it("does not allow overlapping merges", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.mergeCells("B2:C3");

      // intersect four corners
      expect(() => {
        ws.mergeCells("A1:B2");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("C1:D2");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("C3:D4");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("A3:B4");
      }).toThrow(Error);

      // enclosing
      expect(() => {
        ws.mergeCells("A1:D4");
      }).toThrow(Error);
    });

    it("merges and unmerges", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      const expectMaster = function (range, master) {
        const d = new Range(range);
        for (let i = d.top; i <= d.bottom; i++) {
          for (let j = d.left; j <= d.right; j++) {
            const cell = ws.getCell(i, j);
            const masterCell = master ? ws.getCell(master) : cell;
            expect(cell.master.address).toBe(masterCell.address);
          }
        }
      };

      // merge some cells, then unmerge them
      ws.mergeCells("A1:B2");
      expectMaster("A1:B2", "A1");
      ws.unMergeCells("A1:B2");
      expectMaster("A1:B2", null);

      // unmerge just one cell
      ws.mergeCells("A1:B2");
      expectMaster("A1:B2", "A1");
      ws.unMergeCells("A1");
      expectMaster("A1:B2", null);

      ws.mergeCells("A1:B2");
      expectMaster("A1:B2", "A1");
      ws.unMergeCells("B2");
      expectMaster("A1:B2", null);

      // build 4 merge-squares
      ws.mergeCells("A1:B2");
      ws.mergeCells("D1:E2");
      ws.mergeCells("A4:B5");
      ws.mergeCells("D4:E5");

      expectMaster("A1:B2", "A1");
      expectMaster("D1:E2", "D1");
      expectMaster("A4:B5", "A4");
      expectMaster("D4:E5", "D4");

      // unmerge the middle
      ws.unMergeCells("B2:D4");

      expectMaster("A1:B2", null);
      expectMaster("D1:E2", null);
      expectMaster("A4:B5", null);
      expectMaster("D4:E5", null);
    });

    it("does not allow overlapping merges", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      ws.mergeCells("B2:C3");

      // intersect four corners
      expect(() => {
        ws.mergeCells("A1:B2");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("C1:D2");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("C3:D4");
      }).toThrow(Error);
      expect(() => {
        ws.mergeCells("A3:B4");
      }).toThrow(Error);

      // enclosing
      expect(() => {
        ws.mergeCells("A1:D4");
      }).toThrow(Error);
    });

    it("merges styles", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet("blort");

      // initial value
      const B2 = ws.getCell("B2");
      B2.value = 5;
      B2.style.font = testUtils.styles.fonts.broadwayRedOutline20;
      B2.style.border = testUtils.styles.borders.doubleRed;
      B2.style.fill = testUtils.styles.fills.blueWhiteHGrad;
      B2.style.alignment = testUtils.styles.namedAlignments.middleCentre;
      B2.style.numFmt = testUtils.styles.numFmts.numFmt1;

      // expecting styles to be copied (see worksheet spec)
      ws.mergeCells("B2:C3");

      expect(ws.getCell("B2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(ws.getCell("B2").border).toEqual(testUtils.styles.borders.doubleRed);
      expect(ws.getCell("B2").fill).toEqual(testUtils.styles.fills.blueWhiteHGrad);
      expect(ws.getCell("B2").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
      expect(ws.getCell("B2").numFmt).toBe(testUtils.styles.numFmts.numFmt1);

      expect(ws.getCell("B3").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(ws.getCell("B3").border).toEqual(testUtils.styles.borders.doubleRed);
      expect(ws.getCell("B3").fill).toEqual(testUtils.styles.fills.blueWhiteHGrad);
      expect(ws.getCell("B3").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
      expect(ws.getCell("B3").numFmt).toBe(testUtils.styles.numFmts.numFmt1);

      expect(ws.getCell("C2").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(ws.getCell("C2").border).toEqual(testUtils.styles.borders.doubleRed);
      expect(ws.getCell("C2").fill).toEqual(testUtils.styles.fills.blueWhiteHGrad);
      expect(ws.getCell("C2").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
      expect(ws.getCell("C2").numFmt).toBe(testUtils.styles.numFmts.numFmt1);

      expect(ws.getCell("C3").font).toEqual(testUtils.styles.fonts.broadwayRedOutline20);
      expect(ws.getCell("C3").border).toEqual(testUtils.styles.borders.doubleRed);
      expect(ws.getCell("C3").fill).toEqual(testUtils.styles.fills.blueWhiteHGrad);
      expect(ws.getCell("C3").alignment).toEqual(testUtils.styles.namedAlignments.middleCentre);
      expect(ws.getCell("C3").numFmt).toBe(testUtils.styles.numFmts.numFmt1);
    });
  });

  describe("When passed a non-Excel file", () => {
    it("Should not break when importing a .numbers file", () =>
      new Workbook().xlsx
        .readFile(path.resolve(__dirname, "data", "numbers.numbers"))
        .then(workbook => {
          expect(workbook).toHaveProperty("worksheets");
          expect(workbook.worksheets).to.have.length(0);
        }));
  });

  it("Should not break when importing an Excel file that contains a chartsheet", () =>
    new Workbook().xlsx
      .readFile(path.resolve(__dirname, "data", "chart-sheet.xlsx"))
      .then(workbook => {
        expect(workbook).toHaveProperty("worksheets");
        expect(workbook.worksheets).to.have.length(1);
      }));

  describe("Hidden", () => {
    const fileList = [
      "google-sheets",
      "libre-calc-as-excel-2007-365",
      "libre-calc-as-office-open-xml-spreadsheet"
    ];

    for (const file of fileList) {
      it(`Should set hidden attribute correctly (${file})`, async () => {
        const wb = new Workbook();
        await wb.xlsx.readFile(path.resolve(__dirname, "data", "hidden-test", `${file}.xlsx`));

        const ws = wb.getWorksheet(1);
        expect(ws).toBeDefined();

        //  Check rows
        expect(ws!.getRow(1).hidden, `${file} : Row 1`).toBe(false);
        expect(ws!.getRow(2).hidden, `${file} : Row 2`).toBe(true);
        expect(ws!.getRow(3).hidden, `${file} : Row 3`).toBe(false);

        //  Check columns
        expect(ws!.getColumn(1).hidden, `${file} : Column 1`).toBe(false);
        expect(ws!.getColumn(2).hidden, `${file} : Column 2`).toBe(true);
        expect(ws!.getColumn(3).hidden, `${file} : Column 3`).toBe(false);
      });
    }
  });
});
