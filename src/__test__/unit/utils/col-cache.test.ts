import { describe, it, expect } from "vitest";
import { colCache } from "../../../utils/col-cache.js";

describe("colCache", () => {
  it("caches values", () => {
    expect(colCache.l2n("A")).toBe(1);
    expect(colCache._l2n.A).toBe(1);
    expect(colCache._n2l[1]).toBe("A");

    // also, because of the fill heuristic A-Z will be there too
    const dic = [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z"
    ];
    dic.forEach((letter, index) => {
      expect(colCache._l2n[letter]).toBe(index + 1);
      expect(colCache._n2l[index + 1]).toBe(letter);
    });

    // next level
    expect(colCache.n2l(27)).toBe("AA");
    expect(colCache._l2n.AB).toBe(28);
    expect(colCache._n2l[28]).toBe("AB");
  });

  it("converts numbers to letters", () => {
    expect(colCache.n2l(1)).toBe("A");
    expect(colCache.n2l(26)).toBe("Z");
    expect(colCache.n2l(27)).toBe("AA");
    expect(colCache.n2l(702)).toBe("ZZ");
    expect(colCache.n2l(703)).toBe("AAA");
  });
  it("converts letters to numbers", () => {
    expect(colCache.l2n("A")).toBe(1);
    expect(colCache.l2n("Z")).toBe(26);
    expect(colCache.l2n("AA")).toBe(27);
    expect(colCache.l2n("ZZ")).toBe(702);
    expect(colCache.l2n("AAA")).toBe(703);
  });

  it("throws when out of bounds", () => {
    expect(() => {
      colCache.n2l(0);
    }).toThrow(Error);
    expect(() => {
      colCache.n2l(-1);
    }).toThrow(Error);
    expect(() => {
      colCache.n2l(16385);
    }).toThrow(Error);

    expect(() => {
      colCache.l2n("");
    }).toThrow(Error);
    expect(() => {
      colCache.l2n("AAAA");
    }).toThrow(Error);
  });

  it("validates addresses properly", () => {
    expect(colCache.validateAddress("A1")).toBeTruthy();
    expect(colCache.validateAddress("AA10")).toBeTruthy();
    expect(colCache.validateAddress("ABC100000")).toBeTruthy();

    expect(() => {
      colCache.validateAddress("A");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("1");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("1A");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("A 1");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("A1A");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("1A1");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("a1");
    }).toThrow(Error);
    expect(() => {
      colCache.validateAddress("a");
    }).toThrow(Error);
  });

  it("decodes addresses", () => {
    expect(colCache.decodeAddress("A1")).toEqual({
      address: "A1",
      col: 1,
      row: 1,
      $col$row: "$A$1"
    });
    expect(colCache.decodeAddress("AA11")).toEqual({
      address: "AA11",
      col: 27,
      row: 11,
      $col$row: "$AA$11"
    });
  });

  describe("with a malformed address", () => {
    it("tolerates a missing row number", () => {
      expect(colCache.decodeAddress("$B")).toEqual({
        address: "B",
        col: 2,
        row: undefined,
        $col$row: "$B$"
      });
    });

    it("tolerates a missing column number", () => {
      expect(colCache.decodeAddress("$2")).toEqual({
        address: "2",
        col: undefined,
        row: 2,
        $col$row: "$$2"
      });
    });
  });

  it("convert [sheetName!][$]col[$]row[[$]col[$]row] into address or range structures", () => {
    expect(colCache.decodeEx("Sheet1!$H$1")).toEqual({
      $col$row: "$H$1",
      address: "H1",
      col: 8,
      row: 1,
      sheetName: "Sheet1"
    });
    expect(colCache.decodeEx("'Sheet 1'!$H$1")).toEqual({
      $col$row: "$H$1",
      address: "H1",
      col: 8,
      row: 1,
      sheetName: "Sheet 1"
    });
    expect(colCache.decodeEx("'Sheet !$:1'!$H$1")).toEqual({
      $col$row: "$H$1",
      address: "H1",
      col: 8,
      row: 1,
      sheetName: "Sheet !$:1"
    });
    expect(colCache.decodeEx("'Sheet !$:1'!#REF!")).toEqual({
      sheetName: "Sheet !$:1",
      error: "#REF!"
    });
  });

  it("gets address structures (and caches them)", () => {
    let addr = colCache.getAddress("D5");
    expect(addr.address).toBe("D5");
    expect(addr.row).toBe(5);
    expect(addr.col).toBe(4);
    expect(colCache.getAddress("D5")).toBe(addr);
    expect(colCache.getAddress(5, 4)).toBe(addr);

    addr = colCache.getAddress("E4");
    expect(addr.address).toBe("E4");
    expect(addr.row).toBe(4);
    expect(addr.col).toBe(5);
    expect(colCache.getAddress("E4")).toBe(addr);
    expect(colCache.getAddress(4, 5)).toBe(addr);
  });

  it("decodes addresses and ranges", () => {
    // address
    expect(colCache.decode("A1")).toEqual({
      address: "A1",
      col: 1,
      row: 1,
      $col$row: "$A$1"
    });
    expect(colCache.decode("AA11")).toEqual({
      address: "AA11",
      col: 27,
      row: 11,
      $col$row: "$AA$11"
    });

    // range
    expect(colCache.decode("A1:B2")).toEqual({
      dimensions: "A1:B2",
      tl: "A1",
      br: "B2",
      top: 1,
      left: 1,
      bottom: 2,
      right: 2
    });

    // wonky ranges
    expect(colCache.decode("A2:B1")).toEqual({
      dimensions: "A1:B2",
      tl: "A1",
      br: "B2",
      top: 1,
      left: 1,
      bottom: 2,
      right: 2
    });
    expect(colCache.decode("B2:A1")).toEqual({
      dimensions: "A1:B2",
      tl: "A1",
      br: "B2",
      top: 1,
      left: 1,
      bottom: 2,
      right: 2
    });
  });
});
