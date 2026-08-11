import { Cell, Column, Row, Stream, Workbook, Worksheet } from "@excel/index";
import type { ColumnDefn } from "@excel/index";
import { describe, expect, it } from "vitest";

/**
 * Runtime cover for the addressing / column / handle surface.
 *
 * The companion `__tests__/type/cell-addressing-surface.typecheck.ts` pins what
 * compiles; this pins what it *does* — in particular that the `(row, col)` form
 * resolves to the same cell as the `"A1"` form (the two are dispatched on
 * `arguments.length`, so a wrong branch would silently address another cell).
 */
function sheet() {
  const wb = Workbook.create();
  return { wb, ws: Workbook.addWorksheet(wb, "S") };
}

describe("Cell addressing", () => {
  it("resolves (row, col) to the same cell as the A1 form", () => {
    const { ws } = sheet();

    Cell.setValue(ws, "B3", "by-address");
    expect(Cell.getValue(ws, 3, 2)).toBe("by-address");

    Cell.setValue(ws, 4, 2, "by-row-col");
    expect(Cell.getValue(ws, "B4")).toBe("by-row-col");
  });

  it("dispatches every facet setter on both forms", () => {
    const { ws } = sheet();
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "B1", 1);

    Cell.setFont(ws, "A1", { bold: true });
    Cell.setFont(ws, 1, 2, { bold: true });
    expect(Cell.getFont(ws, 1, 1)).toEqual({ bold: true });
    expect(Cell.getFont(ws, "B1")).toEqual({ bold: true });

    Cell.setNumFmt(ws, "A1", "0.00");
    Cell.setNumFmt(ws, 1, 2, "0.00");
    expect(Cell.getNumFmt(ws, 1, 1)).toBe("0.00");
    expect(Cell.getNumFmt(ws, "B1")).toBe("0.00");

    Cell.setAlignment(ws, "A1", { wrapText: true });
    Cell.setAlignment(ws, 1, 2, { wrapText: true });
    expect(Cell.getAlignment(ws, 1, 1)).toEqual({ wrapText: true });
    expect(Cell.getAlignment(ws, "B1")).toEqual({ wrapText: true });

    Cell.setBorder(ws, "A1", { top: { style: "thin" } });
    Cell.setBorder(ws, 1, 2, { top: { style: "thin" } });
    expect(Cell.getBorder(ws, 1, 1)).toEqual({ top: { style: "thin" } });
    expect(Cell.getBorder(ws, "B1")).toEqual({ top: { style: "thin" } });

    const fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } } as const;
    Cell.setFill(ws, "A1", { ...fill });
    Cell.setFill(ws, 1, 2, { ...fill });
    expect(Cell.getFill(ws, 1, 1)).toEqual(fill);
    expect(Cell.getFill(ws, "B1")).toEqual(fill);

    Cell.setProtection(ws, "A1", { locked: false });
    Cell.setProtection(ws, 1, 2, { locked: false });
    expect(Cell.getProtection(ws, 1, 1)).toEqual({ locked: false });
    expect(Cell.getProtection(ws, "B1")).toEqual({ locked: false });

    Cell.setStyle(ws, "A1", { numFmt: "0%" });
    Cell.setStyle(ws, 1, 2, { numFmt: "0%" });
    expect(Cell.getStyle(ws, 1, 1).numFmt).toBe("0%");
    expect(Cell.getStyle(ws, "B1").numFmt).toBe("0%");
  });

  it("dispatches the non-style writers on both forms", () => {
    const { ws } = sheet();
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "B1", 1);

    Cell.setNote(ws, "A1", "left");
    Cell.setNote(ws, 1, 2, "right");
    expect(Cell.getNote(ws, 1, 1)).toBe("left");
    expect(Cell.getNote(ws, "B1")).toBe("right");

    Cell.setValidation(ws, "A1", { type: "whole", operator: "greaterThan", formulae: [0] });
    Cell.setValidation(ws, 1, 2, { type: "whole", operator: "greaterThan", formulae: [0] });
    expect(Cell.getValidation(ws, 1, 1)?.type).toBe("whole");
    expect(Cell.getValidation(ws, "B1")?.type).toBe("whole");

    Cell.setName(ws, "A1", "Left");
    Cell.setName(ws, 1, 2, "Right");
    expect(Cell.getNames(ws, 1, 1)).toEqual(["Left"]);
    expect(Cell.getNames(ws, "B1")).toEqual(["Right"]);
    Cell.removeAllNames(ws, 1, 1);
    expect(Cell.getNames(ws, "A1")).toEqual([]);
  });

  it("reports the same address from both forms", () => {
    const { ws } = sheet();
    Cell.setValue(ws, "C7", 1);
    expect(Cell.getFullAddress(ws, "C7")).toEqual(Cell.getFullAddress(ws, 7, 3));
    expect(Cell.getFullAddress(ws, 7, 3).address).toBe("C7");
  });
});

describe("Cell.view", () => {
  it("reads a handle and stays live", () => {
    const { ws } = sheet();
    Cell.setValue(ws, "A1", 42);
    Cell.setNumFmt(ws, "A1", "0.00");

    const handle = Row.getCell(ws, 1, 1);
    const view = Cell.view(handle);

    expect(view.value).toBe(42);
    // `text` is the raw text, like `Cell.getText`; the numFmt-applied string is
    // `Cell.getDisplayText`.
    expect(view.text).toBe("42");
    expect(Cell.getDisplayText(ws, "A1")).toBe("42.00");
    expect(view.numFmt).toBe("0.00");

    // live projection: no re-reading required after a write through the handle
    Stream.setCellValue(handle, 7);
    expect(view.value).toBe(7);
  });

  it("makes the Row.eachCell handle usable", () => {
    const { ws } = sheet();
    Worksheet.addRow(ws, ["Invoice", "Total"]);

    const headers: string[] = [];
    Row.eachCell(ws, 1, cell => {
      headers.push(Cell.view(cell).text);
      Stream.setCellFont(cell, { bold: true });
    });

    expect(headers).toEqual(["Invoice", "Total"]);
    expect(Cell.getFont(ws, "A1")).toEqual({ bold: true });
  });
});

describe("Column identity and definitions", () => {
  it("maps a key, letter or number to a column number and letter", () => {
    const { ws } = sheet();
    Worksheet.setColumns(ws, [
      { header: "Invoice", key: "invoiceId", width: 20 },
      { header: "Total", key: "total", width: 12 }
    ]);

    expect(Column.getNumber(ws, "total")).toBe(2);
    expect(Column.getNumber(ws, "B")).toBe(2);
    expect(Column.getNumber(ws, 2)).toBe(2);
    expect(Column.getLetter(ws, "total")).toBe("B");
    expect(Column.getLetter(ws, 2)).toBe("B");

    // the key -> (row, col) bridge this exists for
    Cell.setValue(ws, 2, Column.getNumber(ws, "total"), 99);
    expect(Cell.getValue(ws, "B2")).toBe(99);
  });

  it("normalises a definition the same way the library does", () => {
    const { ws } = sheet();
    Worksheet.setColumns(ws, [{ header: "Total", key: "total", width: 12 }]);

    expect(Column.getDefinition(ws, "total")).toEqual({
      header: "Total",
      key: "total",
      width: 12,
      style: {},
      hidden: false,
      outlineLevel: 0,
      bestFit: undefined
    });
  });

  it("returns detached copies that cannot write back", () => {
    const { ws } = sheet();
    Worksheet.setColumns(ws, [{ header: "Total", key: "total", width: 12 }]);

    const defn = Column.getDefinition(ws, "total");
    defn.header = "Mutated";
    defn.width = 999;

    expect(Column.getHeader(ws, "total")).toBe("Total");
    expect(Column.getWidth(ws, "total")).toBe(12);
  });

  it("round-trips the whole layout through columnDefinitions + setColumns", () => {
    const { ws } = sheet();
    Worksheet.setColumns(ws, [
      { header: "Invoice", key: "invoiceId", width: 20 },
      { header: "Total", key: "total", width: 12, style: { numFmt: "#,##0.00" } }
    ]);

    const appended: ColumnDefn[] = [
      ...Worksheet.columnDefinitions(ws),
      { header: "Error", key: "error", width: 40 }
    ];
    Worksheet.setColumns(ws, appended);

    expect(Worksheet.columnDefinitions(ws).map(c => c.key)).toEqual([
      "invoiceId",
      "total",
      "error"
    ]);
    expect(Column.getWidth(ws, "invoiceId")).toBe(20);
    expect(Column.getStyle(ws, "total").numFmt).toBe("#,##0.00");
    expect(Column.getWidth(ws, "error")).toBe(40);
    expect(Column.getNumber(ws, "error")).toBe(3);
  });

  it("keeps `columns` and `columnCount` distinct", () => {
    const { ws } = sheet();
    Worksheet.setColumns(ws, [{ header: "Only", key: "only", width: 10 }]);
    Worksheet.addRow(ws, ["a", "b", "c"]);

    // Three columns hold cells, and the records were padded to match.
    expect(Worksheet.columnCount(ws)).toBe(3);
    expect(Worksheet.columns(ws)).toHaveLength(3);

    // Declaring a column creates its record without creating any cell — this is
    // where the two diverge, and why `columns(ws).length` is not a cell count.
    Column.setWidth(ws, "F", 20);
    expect(Worksheet.columns(ws)).toHaveLength(6);
    expect(Worksheet.columnCount(ws)).toBe(3);
  });
});

describe("Row data from arbitrary objects", () => {
  it("writes a plain interface by column key", () => {
    interface Invoice {
      invoiceId: string;
      total: number;
      customer: { name: string };
    }
    const { ws } = sheet();
    Worksheet.setColumns(ws, [
      { header: "Invoice", key: "invoiceId", width: 20 },
      { header: "Total", key: "total", width: 12 },
      { header: "Customer", key: "customer.name", width: 24 }
    ]);

    const invoices: Invoice[] = [
      { invoiceId: "INV-1", total: 10, customer: { name: "Acme" } },
      { invoiceId: "INV-2", total: 20, customer: { name: "Globex" } }
    ];
    Worksheet.addRows(ws, invoices);

    // row 1 is the header row written by `setColumns`
    expect(Cell.getValue(ws, "A1")).toBe("Invoice");
    expect(Cell.getValue(ws, "A2")).toBe("INV-1");
    expect(Cell.getValue(ws, "B2")).toBe(10);
    expect(Cell.getValue(ws, "C2")).toBe("Acme"); // dotted key
    expect(Cell.getValue(ws, "A3")).toBe("INV-2");
    expect(Cell.getValue(ws, "C3")).toBe("Globex");
  });

  it("still accepts positional arrays", () => {
    const { ws } = sheet();
    Worksheet.addRow(ws, ["a", 1, true]);
    expect(Row.getValues(ws, 1)).toEqual(["a", 1, true]);
  });
});
