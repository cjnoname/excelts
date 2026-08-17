/**
 * Shared spreadsheet helpers.
 *
 * Three concerns that every spreadsheet tool needs and must not re-derive:
 * grid geometry, formula normalization, and rendering a grid as a table a model
 * can address by cell reference.
 */

import { Address, Cell, Workbook, Worksheet } from "documonster/excel";

import { toolError } from "../errors.js";
import { escapeTableCell } from "./result.js";

/** A workbook handle, as the public API hands it back. */
export type WorkbookHandle = ReturnType<typeof Workbook.create>;

/** A worksheet handle. */
export type SheetHandle = ReturnType<typeof Workbook.addWorksheet>;

/** 1-based inclusive grid window, matching `Worksheet.dimensions`. */
export interface GridWindow {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** Excel worksheet limits (ECMA-376 / modern Excel). */
export const MAX_EXCEL_ROWS = 1_048_576;
export const MAX_EXCEL_COLUMNS = 16_384; // XFD

/**
 * Read a worksheet's name.
 *
 * The handle has no public `name` property — `ws.name` is `undefined` — so the
 * model record is the only public route. Verified empirically; do not "simplify"
 * this to `ws.name`.
 */
export function sheetName(ws: SheetHandle): string {
  return Worksheet.getModel(ws).name;
}

/** Every worksheet name in workbook order. */
export function sheetNames(wb: WorkbookHandle): string[] {
  return Workbook.getWorksheets(wb).map(sheetName);
}

/**
 * Resolve a sheet by name or 1-based index, failing with a list of what does
 * exist — a model that picked the wrong name can then correct itself in one
 * step instead of guessing again.
 */
export function requireSheet(wb: WorkbookHandle, sheet: string | number | undefined): SheetHandle {
  const names = sheetNames(wb);

  if (sheet === undefined) {
    const first = Workbook.getWorksheets(wb)[0];
    if (first === undefined) {
      throw toolError.invalidInput("this workbook has no worksheets");
    }
    return first;
  }

  if (typeof sheet === "number") {
    const found = Workbook.getWorksheets(wb)[sheet - 1];
    if (found === undefined) {
      throw toolError.invalidInput(
        `sheet index ${sheet} is out of range (workbook has ${names.length})`,
        `Available sheets: ${names.map(name => JSON.stringify(name)).join(", ")}`
      );
    }
    return found;
  }

  const found = Workbook.getWorksheet(wb, sheet);
  if (found === undefined) {
    throw toolError.invalidInput(
      `no sheet named ${JSON.stringify(sheet)}`,
      `Available sheets: ${names.map(name => JSON.stringify(name)).join(", ")}`
    );
  }
  return found;
}

/**
 * Parse an A1 range into a 1-based window.
 *
 * `Address.decodeRange` returns 0-based `{ s, e }`; `Worksheet.dimensions`
 * returns 1-based `{ top, left, bottom, right }`. Mixing the two is the easiest
 * off-by-one in this package, so the conversion happens exactly here.
 */
export function parseRange(range: string): GridWindow {
  const trimmed = range.trim();
  if (trimmed.length === 0) {
    throw toolError.invalidInput("range must not be empty");
  }

  let decoded;
  try {
    decoded = Address.decodeRange(trimmed.toUpperCase());
  } catch (cause) {
    throw toolError.invalidInput(
      `could not parse range ${JSON.stringify(range)}`,
      'Use A1 notation, e.g. "B2:D10" or "A1".',
      { cause }
    );
  }

  const window: GridWindow = {
    top: decoded.s.r + 1,
    left: decoded.s.c + 1,
    bottom: decoded.e.r + 1,
    right: decoded.e.c + 1
  };

  if (
    !Number.isFinite(window.top) ||
    !Number.isFinite(window.left) ||
    window.top < 1 ||
    window.left < 1 ||
    window.bottom < window.top ||
    window.right < window.left ||
    window.bottom > MAX_EXCEL_ROWS ||
    window.right > MAX_EXCEL_COLUMNS
  ) {
    throw toolError.invalidInput(
      `range ${JSON.stringify(range)} is not a valid rectangle`,
      'Use A1 notation with the top-left cell first, within A1:XFD1048576, e.g. "B2:D10".'
    );
  }

  return window;
}

/**
 * The used area of a sheet, as a 1-based window. Empty sheets yield `undefined`.
 *
 * An empty sheet reports `{ top: 0, left: 0, bottom: 0, right: 0 }` — verified
 * empirically, both freshly created and after a file round-trip. That satisfies
 * `bottom >= top`, so checking only for an inverted rectangle lets zeroes through
 * and the first `columnLetter(0)` then throws `ColumnOutOfBoundsError`. Hence the
 * explicit `>= 1` checks.
 */
export function usedWindow(ws: SheetHandle): GridWindow | undefined {
  const dimensions = Worksheet.dimensions(ws);
  if (
    dimensions.top < 1 ||
    dimensions.left < 1 ||
    dimensions.bottom < dimensions.top ||
    dimensions.right < dimensions.left
  ) {
    return undefined;
  }
  return {
    top: dimensions.top,
    left: dimensions.left,
    bottom: dimensions.bottom,
    right: dimensions.right
  };
}

/**
 * Strip a leading `=` from a formula.
 *
 * Essential, not cosmetic: the core stores formula text WITHOUT the `=`, and
 * passing `"=SUM(A1:A2)"` makes every function resolve to `#NAME?` — including
 * plain arithmetic, so the failure does not even look like a formula problem.
 * Verified empirically. A model will always write the Excel-looking form with
 * the `=`, so normalizing here is what makes the tools usable at all.
 */
export function normalizeFormula(formula: string): string {
  const trimmed = formula.trim();
  return trimmed.startsWith("=") ? trimmed.slice(1).trim() : trimmed;
}

/** Column letter for a 1-based column index. */
export function columnLetter(column: number): string {
  return Address.encodeCol(column - 1);
}

/** `"B7"` for 1-based row/column. */
export function cellRef(row: number, column: number): string {
  return Address.encodeCell({ r: row - 1, c: column - 1 });
}

/** How a cell should be rendered into the output table. */
export type CellMode = "values" | "formulas" | "both";

/**
 * Render one cell as table text.
 *
 * Uses `Cell.getDisplayText`, which applies the cell's number format — so a
 * currency cell reads `1,234.50` rather than `1234.5`, matching what the user
 * sees in Excel and what they will quote back to the model.
 */
export function renderCell(ws: SheetHandle, row: number, column: number, mode: CellMode): string {
  const formula = Cell.getFormula(ws, row, column);

  if (mode === "formulas") {
    return formula === undefined
      ? escapeTableCell(Cell.getDisplayText(ws, row, column))
      : escapeTableCell(`=${formula}`);
  }

  const display = escapeTableCell(Cell.getDisplayText(ws, row, column));
  if (mode === "both" && formula !== undefined) {
    return `${display} \`=${escapeTableCell(formula)}\``;
  }
  return display;
}

/**
 * Render a grid window as a Markdown table with spreadsheet coordinates.
 *
 * The column-letter header row and row-number first column are the point: they
 * let the model answer "which cell is that" and reference `D7` in its next call.
 * A bare table without them forces it to count columns, which it gets wrong.
 */
export function renderGrid(ws: SheetHandle, window: GridWindow, mode: CellMode): string {
  const header = ["", ...rangeOf(window.left, window.right).map(columnLetter)];
  const divider = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];

  for (const row of rangeOf(window.top, window.bottom)) {
    const cells = rangeOf(window.left, window.right).map(column =>
      renderCell(ws, row, column, mode)
    );
    lines.push(`| ${[String(row), ...cells].join(" | ")} |`);
  }

  return lines.join("\n");
}

/** Inclusive integer range as an array. */
export function rangeOf(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += 1) {
    out.push(value);
  }
  return out;
}

/** `"A1:C10"` for a window. */
export function describeWindow(window: GridWindow): string {
  return `${cellRef(window.top, window.left)}:${cellRef(window.bottom, window.right)}`;
}

/**
 * Convert a hex colour to the ARGB string Excel styles use.
 *
 * Accepts `RGB` or `AARRGGBB`, with or without a leading `#`, because a model
 * writes all three.
 */
export function toArgb(color: string): string {
  const hex = color.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) {
    return hex;
  }
  if (/^[0-9A-F]{6}$/.test(hex)) {
    return `FF${hex}`;
  }
  throw toolError.invalidInput(
    `${JSON.stringify(color)} is not a hex colour`,
    'Use RRGGBB or AARRGGBB, e.g. "C00000".'
  );
}
