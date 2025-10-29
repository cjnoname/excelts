import { describe, it, expect } from "vitest";
import { testUtils } from "../utils/index.js";
import { WorkbookWriter, ValueType } from "../../index.js";

const CONCATENATE_HELLO_WORLD = 'CONCATENATE("Hello", ", ", "World!")';

describe("WorksheetWriter", () => {
  describe("Values", () => {
    it("stores values properly", () => {
      const wb = new WorkbookWriter();
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
        formula: CONCATENATE_HELLO_WORLD,
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

      expect(ws.getCell("B2").value.formula).toBe(CONCATENATE_HELLO_WORLD);
      expect(ws.getCell("B2").value.result).toBe("Hello, World!");

      expect(ws.getCell("C2").value.formula).toBe("D1");
      expect(ws.getCell("C2").value.result).toBe(now);
    });

    it("stores shared string values properly", () => {
      const wb = new WorkbookWriter({
        useSharedStrings: true
      });
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
      const wb = new WorkbookWriter();
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
        formula: CONCATENATE_HELLO_WORLD,
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
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
    });

    it("adds rows by contiguous array", () => {
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
    });

    it("sets row styles", () => {
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
  });

  describe("Merge Cells", () => {
    it("references the same top-left value", () => {
      const wb = new WorkbookWriter();
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
      const wb = new WorkbookWriter();
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
  });

  describe("Page Breaks", () => {
    it("adds multiple row breaks", () => {
      const wb = new WorkbookWriter();
      const ws = wb.addWorksheet("blort");

      // initial values
      ws.getCell("A1").value = "A1";
      ws.getCell("B1").value = "B1";
      ws.getCell("A2").value = "A2";
      ws.getCell("B2").value = "B2";
      ws.getCell("A3").value = "A3";
      ws.getCell("B3").value = "B3";

      let row = ws.getRow(1);
      row.addPageBreak();
      row = ws.getRow(2);
      row.addPageBreak();
      expect(ws.rowBreaks.length).toBe(2);
    });
  });
});
