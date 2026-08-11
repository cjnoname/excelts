// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// It pins the `Cell` namespace's addressing contract. Every cell function takes
// exactly two forms — `(ws, "A1", …)` and `(ws, row, col, …)` — expressed as
// overloads rather than an `addr: string | number, col?: number` signature.
//
// That loose signature was not merely imprecise, it was dangerous:
// `Cell.getValue(ws, "A1", 99)` type-checked and silently read `"CUA1"`
// (`colCache.getAddress` composes `n2l(99) + "A1"`), and `Cell.getValue(ws, 5)`
// type-checked and threw `InvalidAddressError` at runtime. The `@ts-expect-error`
// blocks below are the regression guard: if any of them stops erroring, the
// loose signature is back.

import { Cell, Column, Row, Stream, Worksheet } from "@excel/index";
import type {
  CellData,
  CellValue,
  CellView,
  ColumnDefn,
  ColumnView,
  RowValues
} from "@excel/index";

declare const ws: Worksheet.Handle;

// ---------------------------------------------------------------------------
// Both addressing forms, on readers, writers and facet accessors alike
// ---------------------------------------------------------------------------

const byAddress: CellValue = Cell.getValue(ws, "A1");
const byRowCol: CellValue = Cell.getValue(ws, 1, 1);

Cell.setValue(ws, "A1", 42);
Cell.setValue(ws, 1, 1, 42);

Cell.setStyle(ws, "A1", { numFmt: "0.00" });
Cell.setStyle(ws, 1, 1, { numFmt: "0.00" });

// The facet setters used to have no `(row, col)` form at all, forcing callers to
// build A1 strings inside row/column loops.
Cell.setFont(ws, "A1", { bold: true });
Cell.setFont(ws, 1, 1, { bold: true });
Cell.setNumFmt(ws, "A1", "0.00");
Cell.setNumFmt(ws, 1, 1, "0.00");
Cell.setAlignment(ws, "A1", { wrapText: true });
Cell.setAlignment(ws, 1, 1, { wrapText: true });
Cell.setBorder(ws, "A1", { top: { style: "thin" } });
Cell.setBorder(ws, 1, 1, { top: { style: "thin" } });
Cell.setFill(ws, "A1", { type: "pattern", pattern: "solid" });
Cell.setFill(ws, 1, 1, { type: "pattern", pattern: "solid" });
Cell.setProtection(ws, "A1", { locked: true });
Cell.setProtection(ws, 1, 1, { locked: true });

const fontByAddress = Cell.getFont(ws, "A1");
const fontByRowCol = Cell.getFont(ws, 1, 1);

// ---------------------------------------------------------------------------
// Rejected: a string address with a column, and a bare row number
// ---------------------------------------------------------------------------

// @ts-expect-error an "A1" address takes no column argument
Cell.getValue(ws, "A1", 99);
// @ts-expect-error a numeric address requires a column
Cell.getValue(ws, 5);
// @ts-expect-error an "A1" address takes no column argument
Cell.setFont(ws, "A1", 3, { bold: true });
// @ts-expect-error a numeric address requires a column
Cell.setValue(ws, 5, 42);

// ---------------------------------------------------------------------------
// Cell handles: readable through `Cell.view`, writable through `Stream.*`
// ---------------------------------------------------------------------------

Row.eachCell(ws, 1, (cell: CellData, colNumber: number) => {
  const view: CellView = Cell.view(cell);
  const text: string = view.text;
  const value: CellValue = view.value;
  Stream.setCellValue(cell, `${text}${value}${colNumber}`);
});

// ---------------------------------------------------------------------------
// Column: key → number bridge, and definition round-trip
// ---------------------------------------------------------------------------

Worksheet.setColumns(ws, [{ header: "Total", key: "total", width: 12 }]);

const totalCol: number = Column.getNumber(ws, "total");
const totalLetter: string = Column.getLetter(ws, "total");
Cell.setValue(ws, 2, totalCol, 1);

const oneDefn: ColumnDefn = Column.getDefinition(ws, "total");
const allDefns: ColumnDefn[] = Worksheet.columnDefinitions(ws);
Worksheet.setColumns(ws, [...allDefns, { header: "Error", key: "error", width: 40 }]);

// ---------------------------------------------------------------------------
// Row data: a plain interface needs no cast
// ---------------------------------------------------------------------------

interface Invoice {
  invoiceId: string;
  total: number;
}
declare const invoices: Invoice[];

Worksheet.addRow(ws, invoices[0]);
Worksheet.addRows(ws, invoices);
Row.setValues(ws, 2, invoices[0]);
const positional: RowValues = ["a", 1, true];
Worksheet.addRow(ws, positional);

// ---------------------------------------------------------------------------
// Declared columns are read-only: mutate through `Column.*` / `setColumns`
// ---------------------------------------------------------------------------

const declared: readonly ColumnView[] = Worksheet.columns(ws);
const lastDeclared: ColumnView = Worksheet.lastColumn(ws);

// @ts-expect-error the declared-column view is read-only
Worksheet.columns(ws)[0].header = "X";
// @ts-expect-error the declared-column array is read-only
Worksheet.columns(ws).push(Worksheet.columns(ws)[0]);
// @ts-expect-error the view is deeply readonly — nested style included
Worksheet.columns(ws)[0].style.numFmt = "0.00";
// @ts-expect-error the sheet back-reference is not part of the view
void Worksheet.columns(ws)[0].worksheet;

// Style facets stay live references, exactly like `Cell.getStyle` — copy before
// editing. This is a supported read-modify-write, not a leak to be sealed.
Cell.setStyle(ws, "B1", { ...Cell.getStyle(ws, "A1") });

void byAddress;
void byRowCol;
void fontByAddress;
void fontByRowCol;
void totalLetter;
void oneDefn;
void declared;
void lastDeclared;
