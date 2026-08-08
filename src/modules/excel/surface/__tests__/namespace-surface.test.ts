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
    // Object exports (namespaces) — must be exactly these 22.
    const namespaceKeys = Object.keys(Excel)
      .filter(k => typeof (Excel as Record<string, unknown>)[k] === "object")
      .sort();
    expect(namespaceKeys).toEqual([...NAMESPACES].sort());
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
