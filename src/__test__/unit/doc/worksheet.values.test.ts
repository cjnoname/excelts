import { describe, it, expect } from "vitest";
import { Workbook } from "../../../index.js";
import { Enums } from "../../../doc/enums.js";

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

      // constructed string - will share recorded with B1
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

      expect(ws.getCell("A1").type).toBe(Enums.ValueType.Number);
      expect(ws.getCell("B1").type).toBe(Enums.ValueType.String);
      expect(ws.getCell("C1").type).toBe(Enums.ValueType.Number);
      expect(ws.getCell("D1").type).toBe(Enums.ValueType.Date);
      expect(ws.getCell("E1").type).toBe(Enums.ValueType.Hyperlink);

      expect(ws.getCell("A2").type).toBe(Enums.ValueType.Formula);
      expect(ws.getCell("B2").type).toBe(Enums.ValueType.Formula);
      expect(ws.getCell("C2").type).toBe(Enums.ValueType.Formula);
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

      expect(ws.getRow(2).values).toEqual([, 1, "John Doe", dateValue1]);
      expect(ws.getRow(3).values).toEqual([, 2, "Jane Doe", dateValue2]);

      const values = [
        ,
        [, "Id", "Name", "D.O.B."],
        [, 1, "John Doe", dateValue1],
        [, 2, "Jane Doe", dateValue2]
      ];
      ws.eachRow((row, rowNumber) => {
        expect(row.values).toEqual(values[rowNumber]);
        row.eachCell((cell: any, colNumber: any) => {
          expect(cell.value).toBe(values[rowNumber]![colNumber]);
        });
      });
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

      expect(ws.getRow(1).values).toEqual([, 1, "John Doe", dateValue1]);
      expect(ws.getRow(2).values).toEqual([, 2, "Jane Doe", dateValue2]);
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
    });

    describe("Splice", () => {
      describe("Rows", () => {
        it("Remove only", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-remove-only");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.addRow(["5,1", "5,2", "5,3"]);

          ws.spliceRows(2, 1);

          expect(ws).not.toBeUndefined();
          expect(ws.getCell("A1").value).toBe("1,1");
          expect(ws.getCell("A1").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("B1").value).toBe("1,2");
          expect(ws.getCell("B1").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("C1").value).toBe("1,3");
          expect(ws.getCell("C1").type).toBe(Enums.ValueType.String);

          expect(ws.getCell("A2").type).toBe(Enums.ValueType.Null);
          expect(ws.getCell("B2").type).toBe(Enums.ValueType.Null);
          expect(ws.getCell("C2").type).toBe(Enums.ValueType.Null);

          expect(ws.getCell("A3").value).toBe(4.1);
          expect(ws.getCell("A3").type).toBe(Enums.ValueType.Number);
          expect(ws.getCell("B3").type).toBe(Enums.ValueType.Null);
          expect(ws.getCell("C3").value).toBe(4.3);
          expect(ws.getCell("C3").type).toBe(Enums.ValueType.Number);

          expect(ws.getCell("A4").value).toBe("5,1");
          expect(ws.getCell("A4").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("B4").value).toBe("5,2");
          expect(ws.getCell("B4").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("C4").value).toBe("5,3");
          expect(ws.getCell("C4").type).toBe(Enums.ValueType.String);

          ws.addRow(["5,1b", "5,2b", "5,3b"]);
          expect(ws.getCell("A5").value).toBe("5,1b");
          expect(ws.getCell("A5").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("B5").value).toBe("5,2b");
          expect(ws.getCell("B5").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("C5").value).toBe("5,3b");
          expect(ws.getCell("C5").type).toBe(Enums.ValueType.String);
        });
        it("Remove and insert fewer", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-insert-fewer");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.addRow(["5,1", "5,2", "5,3"]);

          ws.spliceRows(2, 2, ["one", "two", "three"]);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3"]);
          expect(ws.getRow(2).values).toEqual([, "one", "two", "three"]);
          expect(ws.getRow(3).values).toEqual([, 4.1, , 4.3]);
          expect(ws.getRow(4).values).toEqual([, "5,1", "5,2", "5,3"]);
        });
        it("Remove and insert same", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-insert-same");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.addRow(["5,1", "5,2", "5,3"]);

          ws.spliceRows(2, 2, ["one", "two", "three"], ["une", "deux", "trois"]);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3"]);
          expect(ws.getRow(2).values).toEqual([, "one", "two", "three"]);
          expect(ws.getRow(3).values).toEqual([, "une", "deux", "trois"]);
          expect(ws.getRow(4).values).toEqual([, 4.1, , 4.3]);
          expect(ws.getRow(5).values).toEqual([, "5,1", "5,2", "5,3"]);
        });
        it("Remove and insert more", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-insert-more");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.addRow(["5,1", "5,2", "5,3"]);

          ws.spliceRows(
            2,
            2,
            ["one", "two", "three"],
            ["une", "deux", "trois"],
            ["uno", "due", "tre"]
          );

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3"]);
          expect(ws.getRow(2).values).toEqual([, "one", "two", "three"]);
          expect(ws.getRow(3).values).toEqual([, "une", "deux", "trois"]);
          expect(ws.getRow(4).values).toEqual([, "uno", "due", "tre"]);
          expect(ws.getRow(5).values).toEqual([, 4.1, , 4.3]);
          expect(ws.getRow(6).values).toEqual([, "5,1", "5,2", "5,3"]);
        });
        it("Remove style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-remove-style");
          ws.addRow(["1,1", "1,2", "1,3", "1,4"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4"]);
          ws.addRow(["3,1", "3,2", "3,3", "3,4"]);
          ws.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ws.getCell("A1").numFmt = "# ?/?";
          ws.getCell("B2").fill = {
            type: "pattern",
            pattern: "darkVertical",
            fgColor: { argb: "FFFF0000" }
          };
          ws.getRow(3).border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" }
          };
          ws.getRow(4).alignment = { horizontal: "left", vertical: "middle" };

          ws.spliceRows(2, 2);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3", "1,4"]);
          expect(ws.getRow(2).values).toEqual([, "4,1", "4,2", "4,3", "4,4"]);
          expect(ws.getCell("A1").style).toEqual({ numFmt: "# ?/?" });
          expect(ws.getRow(2).style).toEqual({
            alignment: { horizontal: "left", vertical: "middle" }
          });
        });
        it("Insert style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-insert-style");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.getCell("A2").fill = {
            type: "pattern",
            pattern: "darkVertical",
            fgColor: { argb: "FFFF0000" }
          };
          ws.getRow(2).alignment = { horizontal: "left", vertical: "middle" };

          ws.spliceRows(2, 0, ["one", "two", "three"]);
          ws.getCell("A2").border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" }
          };

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3"]);
          expect(ws.getRow(2).values).toEqual([, "one", "two", "three"]);
          expect(ws.getRow(3).values).toEqual([, "2,1", "2,2", "2,3"]);
          expect(ws.getRow(3).style.alignment).toEqual({ horizontal: "left", vertical: "middle" });
          expect(ws.getCell("A2").style.border).toEqual({
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" }
          });
          expect(ws.getCell("A3").style.alignment).toEqual({
            horizontal: "left",
            vertical: "middle"
          });
          expect(ws.getCell("A3").style.fill).toEqual({
            type: "pattern",
            pattern: "darkVertical",
            fgColor: { argb: "FFFF0000" }
          });
        });
        it("Replace style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-row-replace-style");
          ws.addRow(["1,1", "1,2", "1,3", "1,4"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4"]);
          ws.addRow(["3,1", "3,2", "3,3", "3,4"]);

          ws.getCell("B1").numFmt = "top";
          ws.getCell("B2").numFmt = "middle";
          ws.getCell("B3").numFmt = "bottom";
          ws.getRow(1).alignment = { horizontal: "left", vertical: "top" };
          ws.getRow(2).alignment = { horizontal: "center", vertical: "middle" };
          ws.getRow(3).alignment = { horizontal: "right", vertical: "bottom" };

          ws.spliceRows(2, 1, ["two-one", "two-two", "two-three", "two-four"]);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,2", "1,3", "1,4"]);
          expect(ws.getRow(2).values).toEqual([, "two-one", "two-two", "two-three", "two-four"]);
          expect(ws.getRow(3).values).toEqual([, "3,1", "3,2", "3,3", "3,4"]);
          expect(ws.getCell("B1").style).toEqual({
            numFmt: "top",
            alignment: { horizontal: "left", vertical: "top" }
          });
          expect(ws.getCell("B2").style).toEqual({});
          expect(ws.getCell("B3").style).toEqual({
            numFmt: "bottom",
            alignment: { horizontal: "right", vertical: "bottom" }
          });
          expect(ws.getRow(1).style).toEqual({
            alignment: { horizontal: "left", vertical: "top" }
          });
          expect(ws.getRow(2).style).toEqual({});
          expect(ws.getRow(3).style).toEqual({
            alignment: { horizontal: "right", vertical: "bottom" }
          });
        });
        it("Remove defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-row-remove-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceRows(2, 2);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "1,2", "1,3", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3].forEach(row => {
              if (row === 3) {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          const wsSingles = wb.addWorksheet("splice-row-remove-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceRows(2, 2);

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", , , "1,4"]);
          expect(wsSingles.getRow(2).values).toEqual([, "4,1", , , "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A2").name).toBe("single-A4");
          expect(wsSingles.getCell("D1").name).toBe("single-D1");
          expect(wsSingles.getCell("D2").name).toBe("single-D4");
        });
        it("Insert defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-row-insert-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceRows(3, 0, ["foo", "bar", "baz", "qux"]);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "1,2", "1,3", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "2,1", "2,2", "2,3", "2,4"]);
          expect(wsSquare.getRow(3).values).toEqual([, "foo", "bar", "baz", "qux"]);
          expect(wsSquare.getRow(4).values).toEqual([, "3,1", "3,2", "3,3", "3,4"]);
          expect(wsSquare.getRow(5).values).toEqual([, "4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4, 5].forEach(row => {
              if (row === 3) {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          const wsSingles = wb.addWorksheet("splice-row-insert-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceRows(3, 0, ["foo", "bar", "baz", "qux"]);

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", , , "1,4"]);
          expect(wsSingles.getRow(3).values).toEqual([, "foo", "bar", "baz", "qux"]);
          expect(wsSingles.getRow(5).values).toEqual([, "4,1", , , "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A5").name).toBe("single-A4");
          expect(wsSingles.getCell("D1").name).toBe("single-D1");
          expect(wsSingles.getCell("D5").name).toBe("single-D4");
        });
        it("Replace defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-row-replace-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceRows(2, 1, ["foo", "bar", "baz", "qux"]);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "1,2", "1,3", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "foo", "bar", "baz", "qux"]);
          expect(wsSquare.getRow(3).values).toEqual([, "3,1", "3,2", "3,3", "3,4"]);
          expect(wsSquare.getRow(4).values).toEqual([, "4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              if (row === 2) {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          const wsSingles = wb.addWorksheet("splice-row-replace-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceRows(2, 1, ["foo", "bar", "baz", "qux"]);

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", , , "1,4"]);
          expect(wsSingles.getRow(2).values).toEqual([, "foo", "bar", "baz", "qux"]);
          expect(wsSingles.getRow(4).values).toEqual([, "4,1", , , "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A4").name).toBe("single-A4");
          expect(wsSingles.getCell("D1").name).toBe("single-D1");
          expect(wsSingles.getCell("D4").name).toBe("single-D4");
        });
      });
      describe("Columns", () => {
        it("splices columns", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-column-remove-only");

          ws.columns = [
            { key: "id", width: 10 },
            { key: "name", width: 32 },
            { key: "dob", width: 10 }
          ];
          ws.addRow({ id: "id1", name: "name1", dob: "dob1" });
          ws.addRow({ id: 2, dob: "dob2" });
          ws.addRow({ name: "name3", dob: 3 });

          ws.spliceColumns(2, 1);

          expect(ws).not.toBeUndefined();
          expect(ws.getCell("A1").value).toBe("id1");
          expect(ws.getCell("A1").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("B1").value).toBe("dob1");
          expect(ws.getCell("B1").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("C1").type).toBe(Enums.ValueType.Null);

          expect(ws.getCell("A2").value).toBe(2);
          expect(ws.getCell("A2").type).toBe(Enums.ValueType.Number);
          expect(ws.getCell("B2").value).toBe("dob2");
          expect(ws.getCell("B2").type).toBe(Enums.ValueType.String);
          expect(ws.getCell("C2").type).toBe(Enums.ValueType.Null);

          expect(ws.getCell("A3").type).toBe(Enums.ValueType.Null);
          expect(ws.getCell("B3").value).toBe(3);
          expect(ws.getCell("B3").type).toBe(Enums.ValueType.Number);
          expect(ws.getCell("C3").type).toBe(Enums.ValueType.Null);
        });
        it("Remove and insert fewer", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-column-insert-fewer");

          ws.addRow(["1,1", "1,2", "1,3", "1,4", "1,5"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4", "2,5"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.getCell("E4").value = 4.5;
          ws.addRow(["5,1", "5,2", "5,3", "5,4", "5,5"]);

          ws.spliceColumns(2, 2, ["one", "two", "three", "four", "five"]);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "one", "1,4", "1,5"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "two", "2,4", "2,5"]);
          expect(ws.getRow(3).values).toEqual([, , "three"]);
          expect(ws.getRow(4).values).toEqual([, 4.1, "four", , 4.5]);
          expect(ws.getRow(5).values).toEqual([, "5,1", "five", "5,4", "5,5"]);
        });
        it("Remove and insert same", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-column-insert-same");

          ws.addRow(["1,1", "1,2", "1,3", "1,4", "1,5"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4", "2,5"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.getCell("E4").value = 4.5;
          ws.addRow(["5,1", "5,2", "5,3", "5,4", "5,5"]);

          ws.spliceColumns(
            2,
            2,
            ["one", "two", "three", "four", "five"],
            ["une", "deux", "trois", "quatre", "cinq"]
          );

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "one", "une", "1,4", "1,5"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "two", "deux", "2,4", "2,5"]);
          expect(ws.getRow(3).values).toEqual([, , "three", "trois"]);
          expect(ws.getRow(4).values).toEqual([, 4.1, "four", "quatre", , 4.5]);
          expect(ws.getRow(5).values).toEqual([, "5,1", "five", "cinq", "5,4", "5,5"]);
        });
        it("Remove and insert more", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-column-insert-more");

          ws.addRow(["1,1", "1,2", "1,3", "1,4", "1,5"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4", "2,5"]);
          ws.getCell("A4").value = 4.1;
          ws.getCell("C4").value = 4.3;
          ws.getCell("E4").value = 4.5;
          ws.addRow(["5,1", "5,2", "5,3", "5,4", "5,5"]);

          ws.spliceColumns(
            2,
            2,
            ["one", "two", "three", "four", "five"],
            ["une", "deux", "trois", "quatre", "cinq"],
            ["uno", "due", "tre", "quatro", "cinque"]
          );

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "one", "une", "uno", "1,4", "1,5"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "two", "deux", "due", "2,4", "2,5"]);
          expect(ws.getRow(3).values).toEqual([, , "three", "trois", "tre"]);
          expect(ws.getRow(4).values).toEqual([, 4.1, "four", "quatre", "quatro", , 4.5]);
          expect(ws.getRow(5).values).toEqual([, "5,1", "five", "cinq", "cinque", "5,4", "5,5"]);
        });
        it("handles column keys", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-column-insert-fewer");
          ws.columns = [
            { key: "id", width: 10 },
            { key: "dob", width: 20 },
            { key: "name", width: 30 },
            { key: "age", width: 40 }
          ];

          const values = [
            { id: "123", name: "Jack", dob: new Date(), age: 0 },
            { id: "124", name: "Jill", dob: new Date(), age: 0 }
          ];
          values.forEach(value => {
            ws.addRow(value);
          });

          ws.spliceColumns(2, 1, ["B1", "B2"], ["C1", "C2"]);

          values.forEach((rowValues, index) => {
            const row = ws.getRow(index + 1);
            Object.entries(rowValues).forEach(([key, value]) => {
              if (key !== "dob") {
                expect(row.getCell(key).value).toBe(value);
              }
            });
          });

          expect(ws.getColumn(1).width).toBe(10);
          expect(ws.getColumn(2).width).toBeUndefined();
          expect(ws.getColumn(3).width).toBeUndefined();
          expect(ws.getColumn(4).width).toBe(30);
          expect(ws.getColumn(5).width).toBe(40);
        });

        it("Splices to end", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-to-end");
          ws.columns = [
            { header: "Col-1", width: 10 },
            { header: "Col-2", width: 10 },
            { header: "Col-3", width: 10 },
            { header: "Col-4", width: 10 },
            { header: "Col-5", width: 10 },
            { header: "Col-6", width: 10 }
          ];

          ws.addRow([1, 2, 3, 4, 5, 6]);
          ws.addRow([1, 2, 3, 4, 5, 6]);

          // splice last 3 columns
          ws.spliceColumns(4, 3);
          expect(ws.getCell(1, 1).value).toBe("Col-1");
          expect(ws.getCell(1, 2).value).toBe("Col-2");
          expect(ws.getCell(1, 3).value).toBe("Col-3");
          expect(ws.getCell(1, 4).value).toBeNull();
          expect(ws.getCell(1, 5).value).toBeNull();
          expect(ws.getCell(1, 6).value).toBeNull();
          expect(ws.getCell(1, 7).value).toBeNull();
          expect(ws.getCell(2, 1).value).toBe(1);
          expect(ws.getCell(2, 2).value).toBe(2);
          expect(ws.getCell(2, 3).value).toBe(3);
          expect(ws.getCell(2, 4).value).toBeNull();
          expect(ws.getCell(2, 5).value).toBeNull();
          expect(ws.getCell(2, 6).value).toBeNull();
          expect(ws.getCell(2, 7).value).toBeNull();
          expect(ws.getCell(3, 1).value).toBe(1);
          expect(ws.getCell(3, 2).value).toBe(2);
          expect(ws.getCell(3, 3).value).toBe(3);
          expect(ws.getCell(3, 4).value).toBeNull();
          expect(ws.getCell(3, 5).value).toBeNull();
          expect(ws.getCell(3, 6).value).toBeNull();
          expect(ws.getCell(3, 7).value).toBeNull();

          expect(ws.getColumn(1).header).toBe("Col-1");
          expect(ws.getColumn(2).header).toBe("Col-2");
          expect(ws.getColumn(3).header).toBe("Col-3");
          expect(ws.getColumn(4).header).toBeUndefined();
          expect(ws.getColumn(5).header).toBeUndefined();
          expect(ws.getColumn(6).header).toBeUndefined();
        });
        it("Splices past end", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-to-end");
          ws.columns = [
            { header: "Col-1", width: 10 },
            { header: "Col-2", width: 10 },
            { header: "Col-3", width: 10 },
            { header: "Col-4", width: 10 },
            { header: "Col-5", width: 10 },
            { header: "Col-6", width: 10 }
          ];

          ws.addRow([1, 2, 3, 4, 5, 6]);
          ws.addRow([1, 2, 3, 4, 5, 6]);

          // splice last 3 columns
          ws.spliceColumns(4, 4);
          expect(ws.getCell(1, 1).value).toBe("Col-1");
          expect(ws.getCell(1, 2).value).toBe("Col-2");
          expect(ws.getCell(1, 3).value).toBe("Col-3");
          expect(ws.getCell(1, 4).value).toBeNull();
          expect(ws.getCell(1, 5).value).toBeNull();
          expect(ws.getCell(1, 6).value).toBeNull();
          expect(ws.getCell(1, 7).value).toBeNull();
          expect(ws.getCell(2, 1).value).toBe(1);
          expect(ws.getCell(2, 2).value).toBe(2);
          expect(ws.getCell(2, 3).value).toBe(3);
          expect(ws.getCell(2, 4).value).toBeNull();
          expect(ws.getCell(2, 5).value).toBeNull();
          expect(ws.getCell(2, 6).value).toBeNull();
          expect(ws.getCell(2, 7).value).toBeNull();
          expect(ws.getCell(3, 1).value).toBe(1);
          expect(ws.getCell(3, 2).value).toBe(2);
          expect(ws.getCell(3, 3).value).toBe(3);
          expect(ws.getCell(3, 4).value).toBeNull();
          expect(ws.getCell(3, 5).value).toBeNull();
          expect(ws.getCell(3, 6).value).toBeNull();
          expect(ws.getCell(3, 7).value).toBeNull();

          expect(ws.getColumn(1).header).toBe("Col-1");
          expect(ws.getColumn(2).header).toBe("Col-2");
          expect(ws.getColumn(3).header).toBe("Col-3");
          expect(ws.getColumn(4).header).toBeUndefined();
          expect(ws.getColumn(5).header).toBeUndefined();
          expect(ws.getColumn(6).header).toBeUndefined();
        });
        it("Splices almost to end", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-to-end");
          ws.columns = [
            { header: "Col-1", width: 10 },
            { header: "Col-2", width: 10 },
            { header: "Col-3", width: 10 },
            { header: "Col-4", width: 10 },
            { header: "Col-5", width: 10 },
            { header: "Col-6", width: 10 }
          ];

          ws.addRow([1, 2, 3, 4, 5, 6]);
          ws.addRow([1, 2, 3, 4, 5, 6]);

          // splice last 3 columns
          ws.spliceColumns(4, 2);
          expect(ws.getCell(1, 1).value).toBe("Col-1");
          expect(ws.getCell(1, 2).value).toBe("Col-2");
          expect(ws.getCell(1, 3).value).toBe("Col-3");
          expect(ws.getCell(1, 4).value).toBe("Col-6");
          expect(ws.getCell(1, 5).value).toBeNull();
          expect(ws.getCell(1, 6).value).toBeNull();
          expect(ws.getCell(1, 7).value).toBeNull();
          expect(ws.getCell(2, 1).value).toBe(1);
          expect(ws.getCell(2, 2).value).toBe(2);
          expect(ws.getCell(2, 3).value).toBe(3);
          expect(ws.getCell(2, 4).value).toBe(6);
          expect(ws.getCell(2, 5).value).toBeNull();
          expect(ws.getCell(2, 6).value).toBeNull();
          expect(ws.getCell(2, 7).value).toBeNull();
          expect(ws.getCell(3, 1).value).toBe(1);
          expect(ws.getCell(3, 2).value).toBe(2);
          expect(ws.getCell(3, 3).value).toBe(3);
          expect(ws.getCell(3, 4).value).toBe(6);
          expect(ws.getCell(3, 5).value).toBeNull();
          expect(ws.getCell(3, 6).value).toBeNull();
          expect(ws.getCell(3, 7).value).toBeNull();

          expect(ws.getColumn(1).header).toBe("Col-1");
          expect(ws.getColumn(2).header).toBe("Col-2");
          expect(ws.getColumn(3).header).toBe("Col-3");
          expect(ws.getColumn(4).header).toBe("Col-6");
          expect(ws.getColumn(5).header).toBeUndefined();
          expect(ws.getColumn(6).header).toBeUndefined();
        });

        it("Remove style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-col-remove-style");
          ws.addRow(["1,1", "1,2", "1,3", "1,4"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4"]);
          ws.addRow(["3,1", "3,2", "3,3", "3,4"]);
          ws.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ws.getCell("A1").numFmt = "# ?/?";
          ws.getCell("B2").fill = {
            type: "pattern",
            pattern: "darkVertical",
            fgColor: { argb: "FFFF0000" }
          };
          ws.getColumn(3).border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" }
          };
          ws.getColumn(4).alignment = { horizontal: "left", vertical: "middle" };

          ws.spliceColumns(2, 2);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "1,4"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "2,4"]);
          expect(ws.getRow(3).values).toEqual([, "3,1", "3,4"]);
          expect(ws.getRow(4).values).toEqual([, "4,1", "4,4"]);
          expect(ws.getCell("A1").style).toEqual({ numFmt: "# ?/?" });
          expect(ws.getColumn(2).style).toEqual({
            alignment: { horizontal: "left", vertical: "middle" }
          });
          expect(ws.getCell("B4").style).toEqual({
            alignment: { horizontal: "left", vertical: "middle" }
          });
        });
        it("Insert style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-col-insert-style");

          ws.addRow(["1,1", "1,2", "1,3"]);
          ws.addRow(["2,1", "2,2", "2,3"]);
          ws.addRow(["3,1", "3,2", "3,3"]);
          ws.getCell("B2").fill = {
            type: "pattern",
            pattern: "darkVertical",
            fgColor: { argb: "FFFF0000" }
          };
          ws.getColumn(2).alignment = { horizontal: "left", vertical: "middle" };

          ws.spliceColumns(2, 0, ["one", "two", "three"]);
          ws.getCell("B2").border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" }
          };

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "one", "1,2", "1,3"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "two", "2,2", "2,3"]);
          expect(ws.getRow(3).values).toEqual([, "3,1", "three", "3,2", "3,3"]);
          expect(ws.getColumn(3).style).toEqual({
            alignment: { horizontal: "left", vertical: "middle" }
          });
          expect(ws.getCell("B2").style).toEqual({
            border: {
              top: { style: "thin" },
              left: { style: "thin" },
              bottom: { style: "thin" },
              right: { style: "thin" }
            }
          });
          expect(ws.getCell("C2").style).toEqual({
            alignment: { horizontal: "left", vertical: "middle" },
            fill: { type: "pattern", pattern: "darkVertical", fgColor: { argb: "FFFF0000" } }
          });
        });
        it("Replace style", () => {
          const wb = new Workbook();
          const ws = wb.addWorksheet("splice-col-replace-style");
          ws.addRow(["1,1", "1,2", "1,3", "1,4"]);
          ws.addRow(["2,1", "2,2", "2,3", "2,4"]);
          ws.addRow(["3,1", "3,2", "3,3", "3,4"]);

          ws.getCell("A2").numFmt = "left";
          ws.getCell("B2").numFmt = "center";
          ws.getCell("C2").numFmt = "right";
          ws.getColumn(1).alignment = { horizontal: "left", vertical: "top" };
          ws.getColumn(2).alignment = { horizontal: "center", vertical: "middle" };
          ws.getColumn(3).alignment = { horizontal: "right", vertical: "bottom" };

          ws.spliceColumns(2, 1, ["one-two", "two-two", "three-two"]);

          expect(ws).not.toBeUndefined();
          expect(ws.getRow(1).values).toEqual([, "1,1", "one-two", "1,3", "1,4"]);
          expect(ws.getRow(2).values).toEqual([, "2,1", "two-two", "2,3", "2,4"]);
          expect(ws.getRow(3).values).toEqual([, "3,1", "three-two", "3,3", "3,4"]);
          expect(ws.getCell("A2").style).toEqual({
            numFmt: "left",
            alignment: { horizontal: "left", vertical: "top" }
          });
          expect(ws.getCell("B2").style).toEqual({});
          expect(ws.getCell("C2").style).toEqual({
            numFmt: "right",
            alignment: { horizontal: "right", vertical: "bottom" }
          });
          expect(ws.getColumn(1).style).toEqual({
            alignment: { horizontal: "left", vertical: "top" }
          });
          expect(ws.getColumn(2).style).toEqual({});
          expect(ws.getColumn(3).style).toEqual({
            alignment: { horizontal: "right", vertical: "bottom" }
          });
        });
        it("Remove defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-col-remove-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceColumns(2, 2);

          const wsSingles = wb.addWorksheet("splice-col-remove-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceColumns(2, 2);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "2,1", "2,4"]);
          expect(wsSquare.getRow(3).values).toEqual([, "3,1", "3,4"]);
          expect(wsSquare.getRow(4).values).toEqual([, "4,1", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3].forEach(row => {
              if (["C", "D"].includes(col)) {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", "1,4"]);
          expect(wsSingles.getRow(4).values).toEqual([, "4,1", "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A4").name).toBe("single-A4");
          expect(wsSingles.getCell("B1").name).toBe("single-D1");
          expect(wsSingles.getCell("B4").name).toBe("single-D4");
        });
        it("Insert defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-col-insert-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceColumns(3, 0, ["foo", "bar", "baz", "qux"]);

          const wsSingles = wb.addWorksheet("splice-col-insert-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceColumns(3, 0, ["foo", "bar", "baz", "qux"]);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "1,2", "foo", "1,3", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "2,1", "2,2", "bar", "2,3", "2,4"]);
          expect(wsSquare.getRow(3).values).toEqual([, "3,1", "3,2", "baz", "3,3", "3,4"]);
          expect(wsSquare.getRow(4).values).toEqual([, "4,1", "4,2", "qux", "4,3", "4,4"]);

          ["A", "B", "C", "D", "E"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              if (col === "C") {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", , "foo", , "1,4"]);
          expect(wsSingles.getRow(4).values).toEqual([, "4,1", , "qux", , "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A4").name).toBe("single-A4");
          expect(wsSingles.getCell("E1").name).toBe("single-D1");
          expect(wsSingles.getCell("E4").name).toBe("single-D4");
        });
        it("Replace defined names", () => {
          const wb = new Workbook();
          const wsSquare = wb.addWorksheet("splice-col-replace-name-square");
          wsSquare.addRow(["1,1", "1,2", "1,3", "1,4"]);
          wsSquare.addRow(["2,1", "2,2", "2,3", "2,4"]);
          wsSquare.addRow(["3,1", "3,2", "3,3", "3,4"]);
          wsSquare.addRow(["4,1", "4,2", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              wsSquare.getCell(col + row).name = "square";
            });
          });

          wsSquare.spliceColumns(2, 1, ["foo", "bar", "baz", "qux"]);

          const wsSingles = wb.addWorksheet("splice-col-replace-name-singles");
          wsSingles.getCell("A1").value = "1,1";
          wsSingles.getCell("A4").value = "4,1";
          wsSingles.getCell("D1").value = "1,4";
          wsSingles.getCell("D4").value = "4,4";

          ["A", "D"].forEach(col => {
            [1, 4].forEach(row => {
              wsSingles.getCell(col + row).name = `single-${col}${row}`;
            });
          });

          wsSingles.spliceColumns(2, 1, ["foo", "bar", "baz", "qux"]);

          expect(wsSquare).not.toBeUndefined();
          expect(wsSquare.getRow(1).values).toEqual([, "1,1", "foo", "1,3", "1,4"]);
          expect(wsSquare.getRow(2).values).toEqual([, "2,1", "bar", "2,3", "2,4"]);
          expect(wsSquare.getRow(3).values).toEqual([, "3,1", "baz", "3,3", "3,4"]);
          expect(wsSquare.getRow(4).values).toEqual([, "4,1", "qux", "4,3", "4,4"]);

          ["A", "B", "C", "D"].forEach(col => {
            [1, 2, 3, 4].forEach(row => {
              if (col === "B") {
                expect(wsSquare.getCell(col + row).name).toBeUndefined();
              } else {
                expect(wsSquare.getCell(col + row).name).toBe("square");
              }
            });
          });

          expect(wsSingles).not.toBeUndefined();
          expect(wsSingles.getRow(1).values).toEqual([, "1,1", "foo", , "1,4"]);
          expect(wsSingles.getRow(4).values).toEqual([, "4,1", "qux", , "4,4"]);
          expect(wsSingles.getCell("A1").name).toBe("single-A1");
          expect(wsSingles.getCell("A4").name).toBe("single-A4");
          expect(wsSingles.getCell("D1").name).toBe("single-D1");
          expect(wsSingles.getCell("D4").name).toBe("single-D4");
        });
      });
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

    it("returns sheet values", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet();

      ws.getCell("A1").value = 11;
      ws.getCell("C1").value = "C1";
      ws.getCell("A2").value = 21;
      ws.getCell("B2").value = "B2";
      ws.getCell("A4").value = "end";

      expect(ws.getSheetValues()).toEqual([, [, 11, , "C1"], [, 21, "B2"], , [, "end"]]);
    });

    it("calculates rowCount and actualRowCount", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet();

      ws.getCell("A1").value = "A1";
      ws.getCell("C1").value = "C1";
      ws.getCell("A3").value = "A3";
      ws.getCell("D3").value = "D3";
      ws.getCell("A4").value = null;
      ws.getCell("B5").value = "B5";

      expect(ws.rowCount).toBe(5);
      expect(ws.actualRowCount).toBe(3);
    });

    it("calculates columnCount and actualColumnCount", () => {
      const wb = new Workbook();
      const ws = wb.addWorksheet();

      ws.getCell("A1").value = "A1";
      ws.getCell("C1").value = "C1";
      ws.getCell("A3").value = "A3";
      ws.getCell("D3").value = "D3";
      ws.getCell("E4").value = null;
      ws.getCell("F5").value = "F5";

      expect(ws.columnCount).toBe(6);
      expect(ws.actualColumnCount).toBe(4);
    });
  });
});
