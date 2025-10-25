import { describe, it, expect, beforeEach } from "vitest";
import { colCache } from "../../../utils/col-cache.js";
import { Cell } from "../../../doc/cell.js";
import { Enums } from "../../../doc/enums.js";

interface SheetMock {
  rows: any[];
  columns: any[];
  reset(): void;
  findRow(num: number): any;
  getRow(num: number): any;
  findColumn(num: number): any;
  getColumn(num: number): any;
  createRow(num: number): any;
  createColumn(num: number): any;
  getCell(address: string): any;
  findCell(address: string): any;
}

const sheetMock: SheetMock = {
  rows: [],
  columns: [],
  reset() {
    this.rows = [];
    this.columns = [];
  },
  findRow(num) {
    return this.rows[num];
  },
  getRow(num) {
    return this.rows[num] || this.createRow(num);
  },
  findColumn(num) {
    return this.columns[num];
  },
  getColumn(num) {
    return this.columns[num] || this.createColumn(num);
  },
  createRow(num) {
    this.rows[num] = {
      cells: [],
      findCell(col: number) {
        return this.cells[col];
      },
      getCell(col: number) {
        return this.cells[col] || this.createCell(col);
      },
      createCell(col: number) {
        const address = colCache.encodeAddress(this.number, col);
        const column = sheetMock.getColumn(col);
        return (this.cells[col] = new Cell(this, column, address));
      },
      number: num,
      get worksheet() {
        return sheetMock;
      }
    };
    return this.rows[num];
  },
  createColumn(num) {
    this.columns[num] = {
      number: num,
      letter: colCache.n2l(num)
    };
    return this.columns[num];
  },
  getCell(address) {
    const fullAddress = colCache.decodeAddress(address);
    const row = this.getRow(fullAddress.row);
    return row.getCell(fullAddress.col);
  },
  findCell(address) {
    const fullAddress = colCache.decodeAddress(address);
    const row = this.getRow(fullAddress.row);
    return row && row.findCell(fullAddress.col);
  }
};

const fonts = {
  arialBlackUI14: {
    name: "Arial Black",
    family: 2,
    size: 14,
    underline: true,
    italic: true
  },
  comicSansUdB16: {
    name: "Comic Sans MS",
    family: 4,
    size: 16,
    underline: "double",
    bold: true
  },
  broadwayRedOutline20: {
    name: "Broadway",
    family: 5,
    size: 20,
    outline: true,
    color: { argb: "FFFF0000" }
  }
};

describe("Cell", () => {
  beforeEach(() => {
    sheetMock.reset();
  });
  it("stores values", () => {
    sheetMock.getRow(1);
    sheetMock.getColumn(1);

    const a1 = sheetMock.getCell("A1");

    expect(a1.address).toBe("A1");
    expect(a1.$col$row).toBe("$A$1");

    expect(a1.type).toBe(Enums.ValueType.Null);

    expect((a1.value = 5)).toBe(5);
    expect(a1.value).toBe(5);
    expect(a1.type).toBe(Enums.ValueType.Number);

    const strValue = "Hello, World!";
    expect((a1.value = strValue)).toBe(strValue);
    expect(a1.value).toBe(strValue);
    expect(a1.type).toBe(Enums.ValueType.String);

    const dateValue = new Date();
    expect((a1.value = dateValue)).toBe(dateValue);
    expect(a1.value).toBe(dateValue);
    expect(a1.type).toBe(Enums.ValueType.Date);

    const formulaValue = { formula: "A2", result: 5 };
    expect((a1.value = formulaValue)).toEqual(formulaValue);
    expect(a1.value).toEqual(formulaValue);
    expect(a1.type).toBe(Enums.ValueType.Formula);

    const hyperlinkValue = {
      hyperlink: "http://www.link.com",
      text: "www.link.com"
    };
    expect((a1.value = hyperlinkValue)).toEqual(hyperlinkValue);
    expect(a1.value).toEqual(hyperlinkValue);
    expect(a1.type).toBe(Enums.ValueType.Hyperlink);

    expect((a1.value = null)).toBeNull();
    expect(a1.type).toBe(Enums.ValueType.Null);

    expect((a1.value = { json: "data" })).toEqual({ json: "data" });
    expect(a1.type).toBe(Enums.ValueType.String);
  });
  it("validates options on construction", () => {
    const row = sheetMock.getRow(1);
    const column = sheetMock.getColumn(1);

    expect(() => {
      new Cell(null, null, "A1");
    }).toThrow(Error);
    expect(() => {
      new Cell(row, null, "A1");
    }).toThrow(Error);
    expect(() => {
      new Cell(null, column, "A1");
    }).toThrow(Error);
  });
  it("merges", () => {
    const a1 = sheetMock.getCell("A1");
    const a2 = sheetMock.getCell("A2");

    a1.value = 5;
    a2.value = "Hello, World!";

    a2.merge(a1);

    expect(a2.value).toBe(5);
    expect(a2.type).toBe(Enums.ValueType.Merge);
    expect(a1._mergeCount).toBe(1);
    expect(a1.isMerged).toBeTruthy();
    expect(a2.isMerged).toBeTruthy();
    expect(a2.isMergedTo(a1)).toBeTruthy();
    expect(a2.master).toBe(a1);
    expect(a1.master).toBe(a1);

    // assignment of slaves write to the master
    a2.value = 7;
    expect(a1.value).toBe(7);

    // assignment of strings should add 1 ref
    const strValue = "Boo!";
    a2.value = strValue;
    expect(a1.value).toBe(strValue);

    // unmerge should work also
    a2.unmerge();
    expect(a2.type).toBe(Enums.ValueType.Null);
    expect(a1._mergeCount).toBe(0);
    expect(a1.isMerged).not.toBeTruthy();
    expect(a2.isMerged).not.toBeTruthy();
    expect(a2.isMergedTo(a1)).not.toBeTruthy();
    expect(a2.master).toBe(a2);
    expect(a1.master).toBe(a1);
  });

  it("upgrades from string to hyperlink", () => {
    sheetMock.getRow(1);
    sheetMock.getColumn(1);

    const a1 = sheetMock.getCell("A1");

    const strValue = "www.link.com";
    const linkValue = "http://www.link.com";

    a1.value = strValue;

    a1._upgradeToHyperlink(linkValue);

    expect(a1.type).toBe(Enums.ValueType.Hyperlink);
  });

  it("doesn't upgrade from non-string to hyperlink", () => {
    sheetMock.getRow(1);
    sheetMock.getColumn(1);

    const a1 = sheetMock.getCell("A1");

    const linkValue = "http://www.link.com";

    // null
    a1._upgradeToHyperlink(linkValue);
    expect(a1.type).toBe(Enums.ValueType.Null);

    // number
    a1.value = 5;
    a1._upgradeToHyperlink(linkValue);
    expect(a1.type).toBe(Enums.ValueType.Number);

    // date
    a1.value = new Date();
    a1._upgradeToHyperlink(linkValue);
    expect(a1.type).toBe(Enums.ValueType.Date);

    // formula
    a1.value = { formula: "A2" };
    a1._upgradeToHyperlink(linkValue);
    expect(a1.type).toBe(Enums.ValueType.Formula);

    // hyperlink
    a1.value = { hyperlink: "http://www.link2.com", text: "www.link2.com" };
    a1._upgradeToHyperlink(linkValue);
    expect(a1.type).toEqual(Enums.ValueType.Hyperlink);

    // cleanup
    a1.value = null;
  });

  it("inherits column styles", () => {
    sheetMock.getRow(1);
    const column = sheetMock.getColumn(1);

    column.style = {
      font: fonts.arialBlackUI14
    };

    const a1 = sheetMock.getCell("A1");
    expect(a1.font).toEqual(fonts.arialBlackUI14);
  });

  it("inherits row styles", () => {
    const row = sheetMock.getRow(1);
    sheetMock.getColumn(1);

    row.style = {
      font: fonts.broadwayRedOutline20
    };

    const a1 = sheetMock.getCell("A1");
    expect(a1.font).toEqual(fonts.broadwayRedOutline20);
  });

  it("has effective types", () => {
    sheetMock.getRow(1);
    sheetMock.getColumn(1);

    const a1 = sheetMock.getCell("A1");

    expect(a1.type).toBe(Enums.ValueType.Null);
    expect(a1.effectiveType).toBe(Enums.ValueType.Null);

    a1.value = 5;
    expect(a1.type).toBe(Enums.ValueType.Number);
    expect(a1.effectiveType).toBe(Enums.ValueType.Number);

    a1.value = "Hello, World!";
    expect(a1.type).toBe(Enums.ValueType.String);
    expect(a1.effectiveType).toBe(Enums.ValueType.String);

    a1.value = new Date();
    expect(a1.type).toBe(Enums.ValueType.Date);
    expect(a1.effectiveType).toBe(Enums.ValueType.Date);

    a1.value = { formula: "A2", result: 5 };
    expect(a1.type).toEqual(Enums.ValueType.Formula);
    expect(a1.effectiveType).toBe(Enums.ValueType.Number);

    a1.value = { formula: "A2", result: "Hello, World!" };
    expect(a1.type).toEqual(Enums.ValueType.Formula);
    expect(a1.effectiveType).toBe(Enums.ValueType.String);

    a1.value = { hyperlink: "http://www.link.com", text: "www.link.com" };
    expect(a1.type).toEqual(Enums.ValueType.Hyperlink);
    expect(a1.effectiveType).toBe(Enums.ValueType.Hyperlink);
  });

  it("shares formulas", () => {
    const a1 = sheetMock.getCell("A1");
    const b1 = sheetMock.getCell("B1");
    const c1 = sheetMock.getCell("C1");

    a1.value = 1;
    b1.value = { formula: "A1+1", result: 2 };
    c1.value = { sharedFormula: "B1", result: 3 };

    expect(b1.type).toBe(Enums.ValueType.Formula);
    expect(b1.formulaType).toBe(Enums.FormulaType.Master);
    expect(c1.type).toBe(Enums.ValueType.Formula);
    expect(c1.formulaType).toBe(Enums.FormulaType.Shared);
    expect(c1.formula).toBe("B1+1");
  });

  it("escapes dangerous html", () => {
    const a1 = sheetMock.getCell("A1");

    a1.value = '<script>alert("yoohoo")</script>';

    expect(a1.html).toBe("&lt;script&gt;alert(&quot;yoohoo&quot;)&lt;/script&gt;");
  });
  it("can set comment", () => {
    const a1 = sheetMock.getCell("A1");

    const comment = {
      texts: [
        {
          font: {
            size: 12,
            color: { theme: 0 },
            name: "Calibri",
            family: 2,
            scheme: "minor"
          },
          text: "This is "
        }
      ],
      margins: {
        insetmode: "auto",
        inset: [0.13, 0.13, 0.25, 0.25]
      },
      protection: {
        locked: "True",
        lockText: "True"
      },
      editAs: "twoCells"
    };

    a1.note = comment;
    a1.value = "test set value";

    expect(a1.model.comment.type).toBe("note");
    expect(a1.model.comment.note).toEqual(comment);
  });

  it("Cell comments supports setting margins, protection, and position properties", () => {
    const a1 = sheetMock.getCell("A1");

    const comment = {
      texts: [
        {
          font: {
            size: 12,
            color: { theme: 0 },
            name: "Calibri",
            family: 2,
            scheme: "minor"
          },
          text: "This is "
        }
      ],
      protection: {
        locked: "False",
        lockText: "True"
      }
    };

    a1.note = comment;
    a1.value = "test set value";

    expect(a1.model.comment.type).toBe("note");
    expect(a1.model.comment.note.texts).toEqual(comment.texts);
    expect(a1.model.comment.note.protection).toEqual(comment.protection);
    expect(a1.model.comment.note.margins.insetmode).toBe("auto");
    expect(a1.model.comment.note.margins.inset).toEqual([0.13, 0.13, 0.25, 0.25]);
    expect(a1.model.comment.note.editAs).toBe("absolute");
  });
});
