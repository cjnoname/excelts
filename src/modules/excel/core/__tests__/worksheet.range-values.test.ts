/**
 * `getRangeValues` — read a rectangular range as a positional, row-major matrix.
 *
 * Surfaced publicly as `Range.getValues(ws, "G7:H19")`. The contract under test:
 * fixed shape, row-major, non-destructive (no cell materialisation), and value
 * semantics identical to a single `Cell.getValue`.
 */
import { getColumnCount, getRowCount } from "@excel/core/worksheet";
import { findCell, findRow, getRangeValues } from "@excel/core/worksheet-core";
import { ExcelError, InvalidAddressError } from "@excel/errors";
import { Cell, Range, Row, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

function sheet(name = "Sheet1") {
  const wb = Workbook.create();
  return Workbook.addWorksheet(wb, name);
}

describe("getRangeValues", () => {
  // ===========================================================================
  // Shape — always exactly the requested rectangle
  // ===========================================================================

  describe("shape", () => {
    it("returns a row-major matrix sized to the range, not to the data", () => {
      const ws = sheet();
      Row.setValues(ws, 7, [null, null, null, null, null, null, "g7", "h7"]);
      Row.setValues(ws, 9, [null, null, null, null, null, null, "g9", "h9"]);

      // row 8 is entirely absent from the sheet
      expect(getRangeValues(ws, "G7:H9")).toEqual([
        ["g7", "h7"],
        [null, null],
        ["g9", "h9"]
      ]);
    });

    it("keeps blank leading and trailing rows/columns", () => {
      const ws = sheet();
      Cell.setValue(ws, "C3", "x");

      expect(getRangeValues(ws, "B2:D4")).toEqual([
        [null, null, null],
        [null, "x", null],
        [null, null, null]
      ]);
    });

    it("reads a range that lies entirely beyond the sheet as nulls", () => {
      const ws = sheet();
      Cell.setValue(ws, "A1", 1);

      const values = getRangeValues(ws, "Z90:AB92");
      expect(values).toEqual([
        [null, null, null],
        [null, null, null],
        [null, null, null]
      ]);
    });

    it("treats a single address as a 1x1 range", () => {
      const ws = sheet();
      Cell.setValue(ws, "G7", 42);

      expect(getRangeValues(ws, "G7")).toEqual([[42]]);
      expect(getRangeValues(ws, "H7")).toEqual([[null]]);
    });

    it("has no holes — every slot is assigned", () => {
      const ws = sheet();
      Cell.setValue(ws, "B2", 1);

      const values = getRangeValues(ws, "A1:C3");
      for (const row of values) {
        expect(row).toHaveLength(3);
        expect(Object.keys(row)).toHaveLength(3); // dense, not a sparse array
      }
    });
  });

  // ===========================================================================
  // Non-destructive — reading never materialises rows or cells
  // ===========================================================================

  describe("non-destructive read", () => {
    it("does not create rows or cells outside the populated area", () => {
      const ws = sheet();
      Cell.setValue(ws, "A1", 1);

      const rowCount = getRowCount(ws);
      const columnCount = getColumnCount(ws);

      getRangeValues(ws, "A1:Z90");

      expect(findRow(ws, 90)).toBeUndefined();
      expect(findCell(ws, "Z90")).toBeUndefined();
      expect(getRowCount(ws)).toBe(rowCount);
      expect(getColumnCount(ws)).toBe(columnCount);
    });

    it("does not widen an existing row", () => {
      const ws = sheet();
      Row.setValues(ws, 1, ["a", "b"]);
      const cellCount = getColumnCount(ws);

      getRangeValues(ws, "A1:H1");

      expect(findCell(ws, "H1")).toBeUndefined();
      expect(getColumnCount(ws)).toBe(cellCount);
    });

    it("leaves the sheet dimensions untouched", () => {
      const ws = sheet();
      Cell.setValue(ws, "B2", 1);
      const before = { ...Worksheet.dimensions(ws) };

      getRangeValues(ws, "A1:J20");

      expect(Worksheet.dimensions(ws)).toEqual(before);
    });
  });

  // ===========================================================================
  // Value semantics — identical to a single Cell.getValue
  // ===========================================================================

  describe("value semantics", () => {
    it("matches Cell.getValue for every cell in the range", () => {
      const ws = sheet();
      Row.setValues(ws, 1, ["a", 1, true]);
      Row.setValues(ws, 2, [null, new Date(Date.UTC(2020, 0, 2))]);

      const values = getRangeValues(ws, "A1:C2");
      Range.forEachAddress(Range.create("A1:C2"), (address, row, col) => {
        expect(values[row - 1][col - 1]).toEqual(Cell.getValue(ws, address));
      });
    });

    it("preserves Date instances", () => {
      const ws = sheet();
      const date = new Date(Date.UTC(2020, 0, 2));
      Cell.setValue(ws, "A1", date);

      expect(getRangeValues(ws, "A1")[0][0]).toEqual(date);
    });

    it("yields the formula record for formula cells, not the cached result", () => {
      const ws = sheet();
      Cell.setValue(ws, "A1", 1);
      Cell.setValue(ws, "B1", { formula: "A1+1", result: 2 });

      expect(getRangeValues(ws, "A1:B1")).toEqual([[1, { formula: "A1+1", result: 2 }]]);
    });

    it("yields the error object for error cells", () => {
      const ws = sheet();
      Cell.setValue(ws, "A1", { error: "#DIV/0!" });

      expect(getRangeValues(ws, "A1")).toEqual([[{ error: "#DIV/0!" }]]);
    });

    it("repeats the master value across a merged region", () => {
      const ws = sheet();
      Worksheet.merge(ws, "A1:B2");
      Cell.setValue(ws, "A1", "m");

      expect(getRangeValues(ws, "A1:B2")).toEqual([
        ["m", "m"],
        ["m", "m"]
      ]);
    });

    it("reads a merged region's slave cells even when the master is outside the range", () => {
      const ws = sheet();
      Worksheet.merge(ws, "A1:B2");
      Cell.setValue(ws, "A1", "m");

      expect(getRangeValues(ws, "B2")).toEqual([["m"]]);
    });
  });

  // ===========================================================================
  // Range resolution
  // ===========================================================================

  describe("range resolution", () => {
    it("accepts a Range handle as well as an A1 string", () => {
      const ws = sheet();
      Row.setValues(ws, 7, [null, null, null, null, null, null, "g7", "h7"]);

      expect(getRangeValues(ws, Range.create(7, 7, 7, 8))).toEqual([["g7", "h7"]]);
      expect(getRangeValues(ws, Range.create("G7:H7"))).toEqual([["g7", "h7"]]);
    });

    it("normalises reversed corners", () => {
      const ws = sheet();
      Row.setValues(ws, 1, ["a", "b"]);
      Row.setValues(ws, 2, ["c", "d"]);

      const expected = [
        ["a", "b"],
        ["c", "d"]
      ];
      expect(getRangeValues(ws, "B2:A1")).toEqual(expected);
      expect(getRangeValues(ws, "A2:B1")).toEqual(expected);
      expect(getRangeValues(ws, Range.create(2, 2, 1, 1))).toEqual(expected);
    });

    it("normalises reversed corners on a hand-built handle", () => {
      const ws = sheet();
      Row.setValues(ws, 1, ["a", "b"]);
      Row.setValues(ws, 2, ["c", "d"]);

      const expected = [
        ["a", "b"],
        ["c", "d"]
      ];
      // `Range.create` normalises, but `Range.Handle` is a plain record a caller
      // can build by hand — a negative height must not reach `new Array()`.
      expect(getRangeValues(ws, { top: 2, left: 1, bottom: 1, right: 2 })).toEqual(expected);
      expect(getRangeValues(ws, { top: 1, left: 2, bottom: 2, right: 1 })).toEqual(expected);
      expect(getRangeValues(ws, { top: 2, left: 2, bottom: 1, right: 1 })).toEqual(expected);
    });

    it("reads a populated sheet's own dimensions", () => {
      const ws = sheet();
      Cell.setValue(ws, "B2", 1);
      Cell.setValue(ws, "C3", 2);

      expect(getRangeValues(ws, Worksheet.dimensions(ws))).toEqual([
        [1, null],
        [null, 2]
      ]);
    });

    it("treats an empty sheet qualifier as absent", () => {
      const ws = sheet("Data");
      Cell.setValue(ws, "A1", 1);

      expect(getRangeValues(ws, { top: 1, left: 1, bottom: 1, right: 1, sheetName: "" })).toEqual([
        [1]
      ]);
    });

    it("ignores absolute markers", () => {
      const ws = sheet();
      Cell.setValue(ws, "B2", "x");

      expect(getRangeValues(ws, "$B$2:$B$2")).toEqual([["x"]]);
    });

    it("accepts a matching sheet qualifier, case-insensitively", () => {
      const ws = sheet("Data");
      Cell.setValue(ws, "A1", 1);

      expect(getRangeValues(ws, "Data!A1")).toEqual([[1]]);
      expect(getRangeValues(ws, "data!A1")).toEqual([[1]]);
    });

    it("accepts a quoted sheet qualifier", () => {
      const ws = sheet("My Sheet");
      Cell.setValue(ws, "A1", 1);

      expect(getRangeValues(ws, "'My Sheet'!A1")).toEqual([[1]]);
    });
  });

  // ===========================================================================
  // Rejected input — fail loudly rather than return a plausible-looking matrix
  // ===========================================================================

  describe("rejected input", () => {
    it("rejects a sheet qualifier naming a different worksheet", () => {
      const ws = sheet("Data");

      expect(() => getRangeValues(ws, "Other!A1:B2")).toThrow(ExcelError);
      expect(() => getRangeValues(ws, "Other!A1:B2")).toThrow(
        /refers to worksheet "Other" but was read from worksheet "Data"/
      );
    });

    it("rejects whole-column and whole-row references", () => {
      const ws = sheet();

      expect(() => getRangeValues(ws, "A:A")).toThrow(InvalidAddressError);
      expect(() => getRangeValues(ws, "A:C")).toThrow(InvalidAddressError);
      expect(() => getRangeValues(ws, "1:5")).toThrow(InvalidAddressError);
    });

    it("rejects an undecodable range string", () => {
      const ws = sheet();

      expect(() => getRangeValues(ws, "nope")).toThrow(InvalidAddressError);
      expect(() => getRangeValues(ws, "")).toThrow(InvalidAddressError);
    });

    it("rejects an unset range handle", () => {
      const ws = sheet();

      expect(() => getRangeValues(ws, Range.create())).toThrow(InvalidAddressError);
      expect(() => getRangeValues(ws, Range.create())).toThrow(/unset or empty/);
    });

    it("rejects the dimensions of a sheet with no cells, and says why", () => {
      const ws = sheet();

      // `Worksheet.dimensions` returns rangeCreate's all-zero unset sentinel.
      expect(Worksheet.dimensions(ws)).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
      expect(() => getRangeValues(ws, Worksheet.dimensions(ws))).toThrow(/unset or empty/);
      // …and not the unrelated whole-column diagnostic
      expect(() => getRangeValues(ws, Worksheet.dimensions(ws))).not.toThrow(/whole-column/);
    });

    it("distinguishes an undecodable string from an unset handle", () => {
      const ws = sheet();

      expect(() => getRangeValues(ws, "A:A")).toThrow(/whole-column/);
      expect(() => getRangeValues(ws, "A:A")).not.toThrow(/unset or empty/);
    });

    it("reports the raw bounds for an unusable handle instead of coercing to A1", () => {
      const ws = sheet();

      // rangeTl/rangeToString coerce 0 to 1, which would misreport as "A1:A1".
      expect(() => getRangeValues(ws, { top: 0, left: 0, bottom: 3, right: 2 })).toThrow(
        /top: 0, left: 0, bottom: 3, right: 2/
      );
    });

    it("rejects non-integer bounds", () => {
      const ws = sheet();

      expect(() => getRangeValues(ws, { top: 1.5, left: 1, bottom: 2, right: 2 })).toThrow(
        InvalidAddressError
      );
    });
  });
});
