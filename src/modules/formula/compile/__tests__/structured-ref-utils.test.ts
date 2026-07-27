/**
 * Unit tests for the structured-reference helper module. The
 * row-range resolver is shared between binder, compiled-formula, and
 * evaluator — correctness here underpins every `Table1[...]` formula.
 */

import { describe, expect, it } from "vitest";

import type { TableGeometryInput } from "../structured-ref-utils";
import {
  buildTableGeometry,
  resolveStructuredRefColumns,
  resolveStructuredRefRows
} from "../structured-ref-utils";

function mkTable(opts: {
  topLeftRow?: number;
  topLeftCol?: number;
  dataRowCount?: number;
  hasHeaderRow?: boolean;
  hasTotalsRow?: boolean;
  columnNames?: string[];
}): TableGeometryInput {
  return {
    topLeft: { row: opts.topLeftRow ?? 1, col: opts.topLeftCol ?? 1 },
    dataRowCount: opts.dataRowCount ?? 5,
    hasHeaderRow: opts.hasHeaderRow ?? true,
    hasTotalsRow: opts.hasTotalsRow ?? false,
    columns: (opts.columnNames ?? ["A", "B", "C"]).map(name => ({ name }))
  };
}

// ---------------------------------------------------------------------------
// buildTableGeometry
// ---------------------------------------------------------------------------

describe("buildTableGeometry", () => {
  it("computes data range for a header-only table", () => {
    const g = buildTableGeometry(mkTable({ topLeftRow: 1, dataRowCount: 5 }));
    expect(g.topLeftRow).toBe(1);
    expect(g.dataRowStart).toBe(2); // header occupies row 1
    expect(g.dataRowEnd).toBe(6); // 5 rows of data: 2..6
    expect(g.hasHeaderRow).toBe(true);
    expect(g.hasTotalsRow).toBe(false);
  });

  it("computes data range for a header-less table", () => {
    const g = buildTableGeometry(mkTable({ topLeftRow: 10, hasHeaderRow: false, dataRowCount: 3 }));
    expect(g.topLeftRow).toBe(10);
    expect(g.dataRowStart).toBe(10); // data starts immediately
    expect(g.dataRowEnd).toBe(12);
    expect(g.hasHeaderRow).toBe(false);
  });

  it("computes data range for header + totals", () => {
    const g = buildTableGeometry(mkTable({ topLeftRow: 1, dataRowCount: 4, hasTotalsRow: true }));
    expect(g.dataRowStart).toBe(2);
    expect(g.dataRowEnd).toBe(5); // 4 data rows between header and totals
    expect(g.hasTotalsRow).toBe(true);
  });

  it("zero data rows still gives a valid (empty) range", () => {
    const g = buildTableGeometry(mkTable({ dataRowCount: 0 }));
    expect(g.dataRowStart).toBe(2);
    expect(g.dataRowEnd).toBe(1); // empty: end < start signals 0 rows
  });
});

// ---------------------------------------------------------------------------
// resolveStructuredRefColumns
// ---------------------------------------------------------------------------

describe("resolveStructuredRefColumns", () => {
  const t = mkTable({ topLeftCol: 2, columnNames: ["Name", "Age", "City"] });

  it("empty columns → full table width", () => {
    const r = resolveStructuredRefColumns([], t, "strict");
    expect(r).toEqual({ colLeft: 2, colRight: 4 });
  });

  it("single column → single-column range", () => {
    const r = resolveStructuredRefColumns(["Age"], t, "strict");
    expect(r).toEqual({ colLeft: 3, colRight: 3 });
  });

  it("two columns span left..right", () => {
    const r = resolveStructuredRefColumns(["Name", "City"], t, "strict");
    expect(r).toEqual({ colLeft: 2, colRight: 4 });
  });

  it("case-insensitive match", () => {
    const r = resolveStructuredRefColumns(["AGE"], t, "strict");
    expect(r).toEqual({ colLeft: 3, colRight: 3 });
  });

  it("strict mode: unknown column → error", () => {
    expect(resolveStructuredRefColumns(["Nope"], t, "strict")).toBe("error");
  });

  it("permissive mode: unknown column is skipped", () => {
    const r = resolveStructuredRefColumns(["Name", "Nope"], t, "permissive");
    expect(r).toEqual({ colLeft: 2, colRight: 2 });
  });

  it("permissive mode: all unknown → full-width fallback", () => {
    const r = resolveStructuredRefColumns(["Nope", "Also"], t, "permissive");
    expect(r).toEqual({ colLeft: 2, colRight: 4 });
  });

  it("columns out-of-order still produce left≤right", () => {
    // Resolver canonicalises: min → colLeft, max → colRight.
    const r = resolveStructuredRefColumns(["City", "Name"], t, "strict");
    expect(r).toEqual({ colLeft: 2, colRight: 4 });
  });
});

// ---------------------------------------------------------------------------
// resolveStructuredRefRows
// ---------------------------------------------------------------------------

describe("resolveStructuredRefRows", () => {
  const withHeader = buildTableGeometry(mkTable({ topLeftRow: 1, dataRowCount: 5 }));
  const withTotals = buildTableGeometry(
    mkTable({ topLeftRow: 1, dataRowCount: 5, hasTotalsRow: true })
  );
  const noHeader = buildTableGeometry(
    mkTable({ topLeftRow: 10, hasHeaderRow: false, dataRowCount: 3 })
  );

  it("empty specials → full data range (default behaviour)", () => {
    expect(resolveStructuredRefRows([], withHeader)).toEqual({
      rowTop: 2,
      rowBottom: 6
    });
  });

  it("[#Data] → same as default", () => {
    expect(resolveStructuredRefRows(["#Data"], withHeader)).toEqual({
      rowTop: 2,
      rowBottom: 6
    });
  });

  it("[#Headers] → header row only", () => {
    expect(resolveStructuredRefRows(["#Headers"], withHeader)).toEqual({
      rowTop: 1,
      rowBottom: 1
    });
  });

  it("[#Totals] → totals row only", () => {
    // With 5 data rows + header at row 1, totals row = 7
    expect(resolveStructuredRefRows(["#Totals"], withTotals)).toEqual({
      rowTop: 7,
      rowBottom: 7
    });
  });

  it("[#All] → header through totals", () => {
    expect(resolveStructuredRefRows(["#All"], withTotals)).toEqual({
      rowTop: 1,
      rowBottom: 7
    });
  });

  it("[#All] without totals still covers header+data", () => {
    expect(resolveStructuredRefRows(["#All"], withHeader)).toEqual({
      rowTop: 1,
      rowBottom: 6
    });
  });

  it("[#This Row] returns the sentinel (caller resolves from address)", () => {
    expect(resolveStructuredRefRows(["#This Row"], withHeader)).toBe("thisRow");
  });

  it("[#Headers,#Data] → header through data-end", () => {
    expect(resolveStructuredRefRows(["#Headers", "#Data"], withHeader)).toEqual({
      rowTop: 1,
      rowBottom: 6
    });
  });

  it("[#Data,#Totals] → data-start through totals", () => {
    expect(resolveStructuredRefRows(["#Data", "#Totals"], withTotals)).toEqual({
      rowTop: 2,
      rowBottom: 7
    });
  });

  it("[#Totals] on table without totals row → error", () => {
    expect(resolveStructuredRefRows(["#Totals"], withHeader)).toBe("error");
  });

  it("[#Headers] on header-less table → error (R8 fix)", () => {
    // Previously silently aliased to the first data row; now explicit.
    expect(resolveStructuredRefRows(["#Headers"], noHeader)).toBe("error");
  });

  it("unknown `#__INVALID__` sentinel → error (R7 fix)", () => {
    expect(resolveStructuredRefRows(["#__INVALID__:BadName"], withHeader)).toBe("error");
  });
});
