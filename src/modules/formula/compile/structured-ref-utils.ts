/**
 * Shared utilities for structured reference (table) row-range resolution.
 *
 * The row-range logic for structured references is needed in three places:
 * - binder (compile-time range resolution)
 * - compiled-formula (static dependency extraction)
 * - evaluator (runtime evaluation)
 *
 * This module provides the canonical implementation to avoid triplication.
 */

/**
 * Minimum subset of table snapshot fields required to derive geometry
 * and resolve structured-reference columns.
 *
 * Declared structurally (not as a nominal import of `TableSnapshot`) so
 * this module stays dependency-free and can serve both compile- and
 * runtime-side callers that carry their own table-shape types.
 */
export interface TableGeometryInput {
  readonly topLeft: { readonly row: number; readonly col: number };
  readonly dataRowCount: number;
  readonly hasHeaderRow: boolean;
  readonly hasTotalsRow: boolean;
  readonly columns: readonly { readonly name: string }[];
}

/**
 * Table geometry needed for structured ref resolution.
 */
export interface TableGeometry {
  /** Top-left row of the table (including header if present). */
  readonly topLeftRow: number;
  /** First row of the data body. */
  readonly dataRowStart: number;
  /** Last row of the data body. */
  readonly dataRowEnd: number;
  /** Whether the table has a header row. */
  readonly hasHeaderRow: boolean;
  /** Whether the table has a totals row. */
  readonly hasTotalsRow: boolean;
}

/**
 * Derive `TableGeometry` from a table's snapshot fields.
 *
 * The data row range excludes the header (if any) but also excludes the
 * totals row — totals, when present, occupy `dataRowEnd + 1`.
 */
export function buildTableGeometry(table: TableGeometryInput): TableGeometry {
  const topLeftRow = table.topLeft.row;
  const dataRowStart = topLeftRow + (table.hasHeaderRow ? 1 : 0);
  const dataRowEnd = dataRowStart + table.dataRowCount - 1;
  return {
    topLeftRow,
    dataRowStart,
    dataRowEnd,
    hasHeaderRow: table.hasHeaderRow,
    hasTotalsRow: table.hasTotalsRow
  };
}

/**
 * Resolve a list of structured-reference column names to a contiguous
 * column range `[colLeft, colRight]` in absolute sheet coordinates.
 *
 * @param columns - Requested column names (case-insensitive match).
 * @param table - Table whose columns are searched.
 * @param mode -
 *   - `"strict"` — return `"error"` if any name is missing (used by
 *     binder and evaluator — unknown columns are `#REF!` errors).
 *   - `"permissive"` — ignore missing names; if ALL names are missing,
 *     falls back to the full table width (used by static-deps extraction,
 *     where a conservative over-estimate is acceptable).
 * @returns `{ colLeft, colRight }`, or `"error"` in strict mode when a
 *   column name is not found. If `columns` is empty, returns the full
 *   table width.
 */
export function resolveStructuredRefColumns(
  columns: readonly string[],
  table: TableGeometryInput,
  mode: "strict" | "permissive"
): { colLeft: number; colRight: number } | "error" {
  const tl = table.topLeft;
  const width = table.columns.length;

  if (columns.length === 0) {
    return { colLeft: tl.col, colRight: tl.col + width - 1 };
  }

  const indices: number[] = [];
  for (const colName of columns) {
    const idx = table.columns.findIndex(c => c.name.toLowerCase() === colName.toLowerCase());
    if (idx === -1) {
      if (mode === "strict") {
        return "error";
      }
      continue;
    }
    indices.push(idx);
  }

  if (indices.length === 0) {
    // permissive + all names missing → conservative full-width fallback
    return { colLeft: tl.col, colRight: tl.col + width - 1 };
  }

  return {
    colLeft: tl.col + Math.min(...indices),
    colRight: tl.col + Math.max(...indices)
  };
}

/**
 * Result of resolving structured reference specials to a row range.
 *
 * - `{rowTop, rowBottom}` — resolved range
 * - `"thisRow"` — the `#This Row` special was used; caller must resolve
 *   using the current cell address
 * - `"error"` — invalid special combination (e.g., #Totals on a table
 *   without a totals row)
 */
export type StructuredRefRowRange = { rowTop: number; rowBottom: number } | "thisRow" | "error";

/**
 * Resolve structured reference specials to a row range.
 *
 * This is the single source of truth for the mapping from
 * `#All`, `#Headers`, `#Data`, `#Totals`, `#This Row` (and their
 * combinations) to concrete row numbers.
 */
export function resolveStructuredRefRows(
  specials: readonly string[],
  geo: TableGeometry
): StructuredRefRowRange {
  // Tokenizer stashes unknown `[#Something]` tokens with a sentinel
  // prefix. Surface them as errors rather than let them alias to the
  // default-data-range path below.
  for (const s of specials) {
    if (s.startsWith("#__INVALID__")) {
      return "error";
    }
  }
  const hasAll = specials.includes("#All");
  const hasHeaders = specials.includes("#Headers");
  const hasTotals = specials.includes("#Totals");
  const hasData = specials.includes("#Data");
  const hasThisRow = specials.includes("#This Row");

  if (hasAll) {
    return {
      rowTop: geo.topLeftRow,
      rowBottom: geo.hasTotalsRow ? geo.dataRowEnd + 1 : geo.dataRowEnd
    };
  }
  if (hasThisRow) {
    return "thisRow";
  }
  if (hasHeaders && hasTotals) {
    return {
      rowTop: geo.topLeftRow,
      rowBottom: geo.hasTotalsRow ? geo.dataRowEnd + 1 : geo.dataRowEnd
    };
  }
  if (hasHeaders && hasData) {
    return {
      rowTop: geo.hasHeaderRow ? geo.topLeftRow : geo.dataRowStart,
      rowBottom: geo.dataRowEnd
    };
  }
  if (hasData && hasTotals) {
    return {
      rowTop: geo.dataRowStart,
      rowBottom: geo.hasTotalsRow ? geo.dataRowEnd + 1 : geo.dataRowEnd
    };
  }
  if (hasHeaders) {
    if (geo.hasHeaderRow) {
      return { rowTop: geo.topLeftRow, rowBottom: geo.topLeftRow };
    }
    // Table without a header row: Excel reports #REF! rather than silently
    // aliasing to the first data row. Returning the data row here would
    // route `Table1[#Headers]` to real data values, masking user mistakes.
    return "error";
  }
  if (hasTotals) {
    if (geo.hasTotalsRow) {
      return { rowTop: geo.dataRowEnd + 1, rowBottom: geo.dataRowEnd + 1 };
    }
    return "error";
  }
  // #Data or no specials → data range
  return { rowTop: geo.dataRowStart, rowBottom: geo.dataRowEnd };
}
