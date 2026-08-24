/**
 * Simplified PDF generation API.
 *
 * Provides a concise way to create PDFs from plain data — no need to manually
 * construct Map objects, compute bounds, or specify cell types.
 *
 * @example Simplest — pass a 2D array:
 * ```typescript
 * import { Pdf } from "documonster/pdf";
 *
 * const bytes = await Pdf.create([
 *   ["Product", "Revenue"],
 *   ["Widget", 1000],
 *   ["Gadget", 2500]
 * ]);
 * ```
 *
 * @example With options:
 * ```typescript
 * const bytes = await Pdf.create([
 *   ["Name", "Score"],
 *   ["Alice", 95],
 *   ["Bob", 87]
 * ], { showGridLines: true, title: "Scores" });
 * ```
 *
 * @example Multiple sheets:
 * ```typescript
 * const bytes = await Pdf.create({
 *   sheets: [
 *     { name: "Sales", data: [["Product", "Revenue"], ["Widget", 1000]] },
 *     { name: "Costs", data: [["Item", "Amount"], ["Rent", 500]] }
 *   ]
 * });
 * ```
 *
 * @example With column widths and styles:
 * ```typescript
 * const bytes = await Pdf.create({
 *   name: "Report",
 *   columns: [{ width: 25 }, { width: 15 }],
 *   data: [
 *     ["Product", "Revenue"],
 *     ["Widget", "$1,000"]
 *   ]
 * });
 * ```
 */

import { exportPdf } from "@pdf/render/pdf-exporter";
import type {
  PdfWorkbook,
  PdfSheetData,
  PdfRowData,
  PdfCellData,
  PdfColumnData,
  PdfCellStyle,
  PdfSheetImage,
  PdfExportOptions
} from "@pdf/types";
import { PdfCellType } from "@pdf/types";

// =============================================================================
// Input Types
// =============================================================================

/** A cell value: string, number, boolean, Date, null, or a styled cell object. */
export type PdfCellValue = string | number | boolean | Date | null | undefined | PdfCell;

/** A cell with an explicit value and optional style overrides. */
export interface PdfCell {
  value: string | number | boolean | Date | null | undefined;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  align?: "left" | "center" | "right";
}

/** A row is an array of cell values. */
export type PdfRow = PdfCellValue[];

/** Column configuration. */
export interface PdfColumn {
  width?: number;
  header?: string;
}

/** An image to embed in a sheet. */
export interface PdfImage {
  /** Raw image bytes (JPEG or PNG). */
  data: Uint8Array;
  /** Image format. */
  format: "jpeg" | "png";
  /**
   * Top-left column position (0-indexed).
   * This is relative to the final sheet grid — if column headers are used,
   * they occupy the first row, so data starts at row 1.
   */
  col: number;
  /**
   * Top-left row position (0-indexed).
   * This is relative to the final sheet grid — if column headers are used,
   * row 0 is the header row, and data rows start at row 1.
   */
  row: number;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
}

/** A single sheet definition. */
export interface PdfSheet {
  name?: string;
  columns?: (PdfColumn | number)[];
  data: PdfRow[];
  images?: PdfImage[];
}

/** A multi-sheet document definition. */
export interface PdfBook {
  title?: string;
  author?: string;
  sheets: PdfSheet[];
}

/**
 * The input to {@link pdf} — can be:
 * - A 2D array (single sheet)
 * - A sheet object `{ name?, columns?, data, images? }`
 * - A workbook object `{ sheets: [...] }`
 */
export type PdfInput = PdfRow[] | PdfSheet | PdfBook;

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a PDF.
 *
 * Accepts anything from a plain 2D array to a multi-sheet workbook.
 * Yields to the event loop between each output page during layout and rendering.
 *
 * @param input   - 2D array, sheet object, or workbook object
 * @param options - PDF export options (page size, margins, etc.)
 * @returns Promise of PDF file as Uint8Array
 */
export async function pdf(input: PdfInput, options?: PdfExportOptions): Promise<Uint8Array> {
  const workbook = normalizeInput(input);
  return exportPdf(workbook, options);
}

// =============================================================================
// Normalization
// =============================================================================

function normalizeInput(input: PdfInput): PdfWorkbook {
  // 2D array → single sheet
  if (Array.isArray(input)) {
    return {
      sheets: [normalizeSheet({ data: input })]
    };
  }

  // Workbook with sheets array
  if ("sheets" in input) {
    return {
      title: input.title,
      creator: input.author,
      sheets: input.sheets.map((s, i) => normalizeSheet(s, i))
    };
  }

  // Single sheet object
  return {
    sheets: [normalizeSheet(input)]
  };
}

function normalizeSheet(sheet: PdfSheet, index?: number): PdfSheetData {
  const data = sheet.data;
  const sheetName = sheet.name ?? `Sheet${(index ?? 0) + 1}`;

  // Check if columns have headers
  const columnHeaders = sheet.columns?.map(c => (typeof c === "number" ? undefined : c.header));
  const hasHeaders = columnHeaders?.some(h => h !== undefined) ?? false;

  // Determine dimensions — consider data rows, column definitions, and images
  let maxCols = 0;
  for (const row of data) {
    if (row.length > maxCols) {
      maxCols = row.length;
    }
  }
  let colCount = Math.max(maxCols, sheet.columns?.length ?? 0);
  let totalRows = data.length + (hasHeaders ? 1 : 0);

  // Pre-scan images to extend bounds before the empty check
  if (sheet.images) {
    for (const img of sheet.images) {
      const imgCol = img.col + 1; // 0-indexed → 1-indexed
      const imgRow = img.row + 1;
      if (imgCol > colCount) {
        colCount = imgCol;
      }
      if (imgRow > totalRows) {
        totalRows = imgRow;
      }
    }
  }

  if (colCount === 0) {
    return {
      name: sheetName,
      bounds: { top: 0, left: 0, bottom: 0, right: 0 },
      columns: new Map(),
      rows: new Map()
    };
  }

  // Build columns
  const columns = new Map<number, PdfColumnData>();
  if (sheet.columns) {
    for (let i = 0; i < sheet.columns.length; i++) {
      const col = sheet.columns[i];
      const width = typeof col === "number" ? col : col.width;
      columns.set(i + 1, { width: width ?? 12 });
    }
  }
  // Fill missing columns with default width
  for (let c = 1; c <= colCount; c++) {
    if (!columns.has(c)) {
      columns.set(c, { width: 12 });
    }
  }

  // Build rows
  const rows = new Map<number, PdfRowData>();
  let rowOffset = 1;

  // Insert column headers as the first row if provided
  if (hasHeaders && columnHeaders) {
    const cells = new Map<number, PdfCellData>();
    for (let c = 0; c < columnHeaders.length; c++) {
      const text = columnHeaders[c];
      if (text === undefined) {
        continue;
      }
      cells.set(c + 1, {
        type: PdfCellType.String,
        value: text,
        text,
        col: c + 1,
        style: { font: { bold: true } }
      });
    }
    rows.set(1, { cells });
    rowOffset = 2;
  }

  // Insert data rows
  for (let r = 0; r < data.length; r++) {
    const rowNum = r + rowOffset;
    const row = data[r];
    const cells = new Map<number, PdfCellData>();

    for (let c = 0; c < row.length; c++) {
      const cell = normalizeCell(row[c], c + 1);
      if (cell) {
        cells.set(c + 1, cell);
      }
    }

    rows.set(rowNum, { cells });
  }

  // Normalize images
  let images: PdfSheetImage[] | undefined;

  if (sheet.images && sheet.images.length > 0) {
    images = sheet.images.map(img => ({
      data: img.data,
      format: img.format,
      range: {
        tl: { col: img.col, row: img.row },
        ext: { width: img.width, height: img.height }
      }
    }));

    // Ensure columns and rows exist for the image-extended bounds
    for (let c = 1; c <= colCount; c++) {
      if (!columns.has(c)) {
        columns.set(c, { width: 12 });
      }
    }
    for (let r = 1; r <= totalRows; r++) {
      if (!rows.has(r)) {
        rows.set(r, { cells: new Map() });
      }
    }
  }

  return {
    name: sheetName,
    bounds: { top: 1, left: 1, bottom: totalRows, right: colCount },
    columns,
    rows,
    images
  };
}

function normalizeCell(value: PdfCellValue, col: number): PdfCellData | null {
  if (value === null || value === undefined) {
    return null;
  }

  // Styled cell object
  if (typeof value === "object" && !(value instanceof Date) && "value" in value) {
    const cell = value as PdfCell;
    const inner = normalizeCell(cell.value, col);
    if (!inner) {
      return null;
    }

    // Apply style overrides
    const style: Partial<PdfCellStyle> = {};
    if (cell.bold || cell.italic || cell.fontSize || cell.fontColor) {
      style.font = {
        bold: cell.bold,
        italic: cell.italic,
        size: cell.fontSize,
        color: cell.fontColor ? { argb: cell.fontColor } : undefined
      };
    }
    if (cell.fillColor) {
      style.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: cell.fillColor }
      };
    }
    if (cell.align) {
      style.alignment = { horizontal: cell.align };
    }

    inner.style = style;
    return inner;
  }

  // Primitive values
  if (typeof value === "string") {
    return { type: PdfCellType.String, value, text: value, col };
  }
  if (typeof value === "number") {
    return { type: PdfCellType.Number, value, text: String(value), col };
  }
  if (typeof value === "boolean") {
    return { type: PdfCellType.Boolean, value, text: value ? "TRUE" : "FALSE", col };
  }
  if (value instanceof Date) {
    return { type: PdfCellType.Date, value, text: value.toLocaleDateString(), col };
  }

  return null;
}
