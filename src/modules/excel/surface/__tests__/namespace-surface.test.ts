/**
 * Public namespace-surface contract for `documonster/excel`.
 *
 * Locks the shape of the dot-namespace API (`Workbook`, `Cell`, `Chart`, …):
 * each namespace exists, key members are callable, and a representative
 * member actually delegates to the underlying engine. Guards against
 * accidental removal / rename of public surface members and verifies the
 * `(ws, addr, …)` facade wiring end-to-end.
 */
import * as Excel from "@excel/index";
import { describe, it, expect } from "vitest";

describe("documonster/excel namespace surface", () => {
  it("exposes exactly the expected domain namespaces", () => {
    const NAMESPACES = [
      "Address",
      "Anchor",
      "Cell",
      "Chart",
      "Chartsheet",
      "Column",
      "DataValidation",
      "DefinedNames",
      "Form",
      "Format",
      "HeaderFooterImage",
      "Image",
      "Note",
      "Pivot",
      "Range",
      "Row",
      "Sparkline",
      "Stream",
      "Table",
      "Watermark",
      "Workbook",
      "Worksheet"
    ];
    /**
     * Constant lookup objects (not namespaces): each doubles as its own type,
     * e.g. `Cell.getType(ws, "A1") === ValueType.Number`.
     */
    const CONSTANTS = ["ErrorValue", "FormulaType", "PaperSize", "ValueType"];
    // Object exports — must be exactly the 22 namespaces plus the lookups.
    const objectKeys = Object.keys(Excel)
      .filter(k => typeof (Excel as Record<string, unknown>)[k] === "object")
      .sort();
    expect(objectKeys).toEqual([...NAMESPACES, ...CONSTANTS].sort());
  });

  it("exposes the value-kind lookups as usable values", () => {
    expect(Excel.ValueType.Number).toBe(2);
    expect(Excel.FormulaType.Master).toBe(1);
    expect(Excel.ErrorValue.NotApplicable).toBe("#N/A");
    expect(Excel.PaperSize.A4).toBe(9);
  });

  it("exposes error classes consistently with other modules", () => {
    // excel, like word/csv/markdown/xml/pdf/stream, exports its BaseError
    // subclasses + guard from the package entry for instanceof checks.
    const e = Excel as Record<string, unknown>;
    for (const name of [
      "ExcelError",
      "isExcelError",
      "WorksheetNameError",
      "InvalidAddressError",
      "ChartOptionsError",
      "ColumnOutOfBoundsError"
    ]) {
      expect(typeof e[name], name).toBe("function");
    }
  });

  it("Workbook namespace exposes core lifecycle members as functions", () => {
    for (const m of [
      "create",
      "addWorksheet",
      "getWorksheet",
      "getWorksheets",
      "removeWorksheet",
      "toBuffer",
      "read",
      "readFile",
      "writeFile"
    ]) {
      expect(typeof (Excel.Workbook as Record<string, unknown>)[m], `Workbook.${m}`).toBe(
        "function"
      );
    }
  });

  it("Cell namespace exposes value + style facade members", () => {
    for (const m of [
      "getValue",
      "setValue",
      "find",
      "view",
      "getFont",
      "setFont",
      "setNumFmt",
      "setAlignment",
      "setBorder",
      "setFill",
      "getComment",
      "setComment"
    ]) {
      expect(typeof (Excel.Cell as Record<string, unknown>)[m], `Cell.${m}`).toBe("function");
    }
  });

  /**
   * A number format is owned by a cell, a row or a column depending on the sheet,
   * and a consumer who finds `Cell.setNumFmt` reaches for `Column.setNumFmt`
   * next. That guess used to fail — `Column` had no facet setter at all and `Row`
   * was missing this one — so three examples had to reach into `@excel/core` to
   * format a column.
   *
   * Only `setNumFmt` and `setStyle` are asserted, because only those two exist on
   * all three. The remaining facets go through `setStyle` on a row or column
   * (`setStyle(ws, col, { font })`), which is both sufficient and a single pass;
   * per-facet setters for them would be public API with no caller.
   */
  it("Cell, Row and Column can all set a number format and a style", () => {
    // Static property access on the namespace, then a computed member lookup —
    // indexing `Excel` itself defeats the linter's namespace validation.
    const surfaces: [string, Record<string, unknown>][] = [
      ["Cell", Excel.Cell as unknown as Record<string, unknown>],
      ["Row", Excel.Row as unknown as Record<string, unknown>],
      ["Column", Excel.Column as unknown as Record<string, unknown>]
    ];
    for (const [name, surface] of surfaces) {
      for (const m of ["setNumFmt", "setStyle"]) {
        expect(typeof surface[m], `${name}.${m}`).toBe("function");
      }
    }
  });

  it("Column.setNumFmt applies to the column and to cells already in it", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "C1", 1234.5);

    Excel.Column.setNumFmt(ws, "C", "#,##0.00");

    // The facet lands on the column's own style …
    expect(Excel.Column.getStyle(ws, "C").numFmt).toBe("#,##0.00");
    // … and propagates to the cell that already existed, which is why this is a
    // function and not a property assignment.
    expect(Excel.Cell.getNumFmt(ws, "C1")).toBe("#,##0.00");
    // … and to cells created afterwards.
    Excel.Cell.setValue(ws, "C2", 99);
    expect(Excel.Cell.getNumFmt(ws, "C2")).toBe("#,##0.00");
  });

  it("Row.setNumFmt applies to the row and to cells already in it", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "A3", 0.25);

    Excel.Row.setNumFmt(ws, 3, "0.00%");

    expect(Excel.Row.getStyle(ws, 3).numFmt).toBe("0.00%");
    expect(Excel.Cell.getNumFmt(ws, "A3")).toBe("0.00%");
  });

  /**
   * Every one of these signatures accepts `| undefined`, so all three must clear.
   * `Row.*` used to guard with `if (value !== undefined)` and silently keep the
   * old value — five row setters whose signature said one thing and whose body
   * did another, with no test on either side of the difference.
   */
  it("Cell, Row and Column all clear a facet when passed undefined", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "A1", 1);

    Excel.Cell.setNumFmt(ws, "A1", "0.00");
    Excel.Cell.setNumFmt(ws, "A1", undefined);
    expect(Excel.Cell.getNumFmt(ws, "A1")).toBeUndefined();

    Excel.Row.setNumFmt(ws, 2, "0.00");
    Excel.Row.setNumFmt(ws, 2, undefined);
    expect(Excel.Row.getStyle(ws, 2).numFmt).toBeUndefined();

    Excel.Column.setNumFmt(ws, "C", "0.00");
    Excel.Column.setNumFmt(ws, "C", undefined);
    expect(Excel.Column.getStyle(ws, "C").numFmt).toBeUndefined();

    // The other row facets share the implementation that used to swallow it.
    Excel.Row.setFont(ws, 4, { bold: true });
    Excel.Row.setFont(ws, 4, undefined);
    expect(Excel.Row.getStyle(ws, 4).font).toBeUndefined();
  });

  it("clearing a row facet also clears it on cells already in the row", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "A5", 1);

    Excel.Row.setNumFmt(ws, 5, "0.00");
    expect(Excel.Cell.getNumFmt(ws, "A5")).toBe("0.00");

    Excel.Row.setNumFmt(ws, 5, undefined);
    expect(Excel.Cell.getNumFmt(ws, "A5")).toBeUndefined();
  });

  it("Cell.find reports absence without materialising the cell", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "A1", "here");

    expect(Excel.Cell.find(ws, "A1")).toBeDefined();
    expect(Excel.Cell.find(ws, "B50")).toBeUndefined();
    expect(Excel.Cell.find(ws, 50, 2)).toBeUndefined();
    // The probe left the sheet alone — the whole point of `find`.
    expect(Excel.Worksheet.rowCount(ws)).toBe(1);

    // Contrast: every other reader resolves through `getCell`, which creates.
    Excel.Cell.getValue(ws, "B50");
    expect(Excel.Worksheet.rowCount(ws)).toBe(50);
  });

  it("Cell.find hands back a handle readable through Cell.view", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "D4", 7);
    Excel.Cell.setNumFmt(ws, "D4", "0.00");

    const cell = Excel.Cell.find(ws, "D4")!;
    expect(Excel.Cell.view(cell).value).toBe(7);
    // `text` is the value's own string form; the format sits beside it rather
    // than being applied to it.
    expect(Excel.Cell.view(cell).text).toBe("7");
    expect(Excel.Cell.view(cell).numFmt).toBe("0.00");
  });

  it("Cell.find addresses by (row, col) only when given three arguments", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "B2", "b2");

    expect(Excel.Cell.find(ws, 2, 2)).toBe(Excel.Cell.find(ws, "B2"));
    // The 2-arg form must not treat a trailing column as part of the address.
    expect(Excel.Cell.find(ws, "B2")).toBeDefined();
  });

  it("Chart / Table / Pivot / Sparkline / Image creation members exist", () => {
    expect(typeof Excel.Chart.add).toBe("function");
    expect(typeof Excel.Chart.addBar).toBe("function");
    expect(typeof Excel.Chart.get).toBe("function");
    expect(typeof Excel.Table.add).toBe("function");
    expect(typeof Excel.Pivot.add).toBe("function");
    expect(typeof Excel.Sparkline.add).toBe("function");
    expect(typeof Excel.Image.place).toBe("function");
  });

  it("Stream namespace exposes the streaming classes + handle ops", () => {
    expect(typeof Excel.Stream.WorkbookWriter).toBe("function"); // class
    expect(typeof Excel.Stream.WorkbookReader).toBe("function"); // class
    expect(typeof Excel.Stream.setCellValue).toBe("function");
    expect(typeof Excel.Stream.commitRow).toBe("function");
  });

  it("Format namespace parses a value against a target cell's own numFmt", () => {
    expect(typeof Excel.Format.parseValueByFormat).toBe("function");
    expect(Excel.Format.parseValueByFormat("dd/mm/yyyy", "09/07/2026")).toEqual(
      new Date(Date.UTC(2026, 6, 9))
    );
  });

  it("Address namespace exposes stateless encode/decode utilities (0-indexed)", () => {
    expect(Excel.Address.decodeCol("B")).toBe(1);
    expect(Excel.Address.encodeCol(1)).toBe("B");
    expect(Excel.Address.decodeCell("C3")).toMatchObject({ c: 2, r: 2 });
  });

  it("Workbook + Cell delegate end-to-end (facade wiring)", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "Sheet1");

    Excel.Cell.setValue(ws, "A1", 42);
    expect(Excel.Cell.getValue(ws, "A1")).toBe(42);

    Excel.Cell.setValue(ws, "B2", "hello");
    expect(Excel.Cell.getValue(ws, "B2")).toBe("hello");

    // round-trip a worksheet lookup
    expect(Excel.Workbook.getWorksheet(wb, "Sheet1")).toBe(ws);
    expect(Excel.Workbook.getWorksheets(wb)).toContain(ws);
  });

  it("Row facade resolves the row and sets values", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Row.setValues(ws, 1, ["a", "b", "c"]);
    expect(Excel.Cell.getValue(ws, "A1")).toBe("a");
    expect(Excel.Cell.getValue(ws, "C1")).toBe("c");
  });

  it("Range namespace exposes geometry helpers plus getValues", () => {
    for (const m of ["create", "contains", "intersects", "forEachAddress", "count", "getValues"]) {
      expect(typeof (Excel.Range as Record<string, unknown>)[m], `Range.${m}`).toBe("function");
    }
  });

  it("Range.getValues reads a positional matrix off the sheet", () => {
    const wb = Excel.Workbook.create();
    const ws = Excel.Workbook.addWorksheet(wb, "S");
    Excel.Cell.setValue(ws, "G7", 1);
    Excel.Cell.setValue(ws, "H8", "x");

    const values: Excel.Cell.Value[][] = Excel.Range.getValues(ws, "G7:H9");
    expect(values).toEqual([
      [1, null],
      [null, "x"],
      [null, null]
    ]);
    // accepts a Range.Handle as well as an A1 string
    expect(Excel.Range.getValues(ws, Excel.Range.create(7, 7, 9, 8))).toEqual(values);
  });
});
