/**
 * Pure OOXML data types and constants for pivot tables.
 *
 * This module contains only the data-layer declarations needed by the xlsx
 * serialization layer (`xlsx/xform/pivot-table/*`). It deliberately depends on
 * nothing above the foundational layers — no `@excel/range`, `@excel/table`,
 * `@excel/row`, `@excel/column`, `@excel/chart/*`, `@excel/worksheet-core`, or
 * the domain `@excel/pivot-table` module itself — so the serialization layer
 * can consume these types without creating an upward dependency on the domain
 * layer.
 */

/** Allowed element types within CacheField.sharedItems */
export type SharedItemValue = string | number | boolean | Date | PivotError | null;

/**
 * Tagged value for OOXML error entries in sharedItems (e.g. `<e v="REF!"/>`).
 * Distinguishes error codes from regular strings so they round-trip as `<e>`
 * rather than `<s>`. A plain data record (not a class) — use {@link pivotError}
 * to construct and {@link isPivotError} to narrow.
 */
export interface PivotError {
  readonly kind: "pivotError";
  /** The error code without the leading '#' (e.g. "REF!", "VALUE!", "N/A"). */
  readonly code: string;
}

/** Construct a {@link PivotError} from an error code (without leading '#'). */
export function pivotError(code: string): PivotError {
  return { kind: "pivotError", code };
}

/** Type guard: is `v` a {@link PivotError} tagged value? */
export function isPivotError(v: unknown): v is PivotError {
  return typeof v === "object" && v !== null && (v as PivotError).kind === "pivotError";
}

/** Display form of a pivot error with the '#' prefix, e.g. "#REF!". */
export function formatPivotError(err: PivotError): string {
  return `#${err.code}`;
}

/**
 * Represents a cache field in a pivot table.
 * Cache fields store unique values from source columns for row/column grouping.
 */
export interface CacheField {
  /** Name of the field (column header from source) */
  name: string;
  /** Unique values for row/column fields, null for value fields */
  sharedItems: SharedItemValue[] | null;
  /** Whether the field contains numeric values (raw attribute string for roundtrip: "0" or "1") */
  containsNumber?: string;
  /** Whether the field contains only integer values (raw attribute string for roundtrip: "0" or "1") */
  containsInteger?: string;
  /** Minimum value for numeric fields */
  minValue?: number;
  /** Maximum value for numeric fields */
  maxValue?: number;
  /** Number format ID (preserved on roundtrip, defaults to "0") */
  numFmtId?: string;
  // ----- Loaded sharedItems attribute preservation (roundtrip fidelity) -----
  /** Original containsSemiMixedTypes attribute from loaded file */
  containsSemiMixedTypes?: string;
  /** Original containsNonDate attribute from loaded file */
  containsNonDate?: string;
  /** Original containsString attribute from loaded file */
  containsString?: string;
  /** Original containsBlank attribute from loaded file */
  containsBlank?: string;
  /** Original containsDate attribute from loaded file */
  containsDate?: string;
  /** Original containsMixedTypes attribute from loaded file */
  containsMixedTypes?: string;
  /** Flag indicating this cache field was loaded from file */
  isLoaded?: boolean;
  /** Preserved <fieldGroup> raw XML for roundtrip (loaded models only) */
  fieldGroupXml?: string;
  /** Bag of additional cacheField attributes not individually modeled (for roundtrip preservation) */
  extraAttrs?: Record<string, string>;
}

/** Aggregation function types for pivot table data fields */
export type PivotTableSubtotal =
  | "sum"
  | "count"
  | "average"
  | "max"
  | "min"
  | "product"
  | "countNums"
  | "stdDev"
  | "stdDevP"
  | "var"
  | "varP";

/** Map from PivotTableSubtotal to its Excel display name prefix */
export const METRIC_DISPLAY_NAMES: Readonly<Record<PivotTableSubtotal, string>> = {
  sum: "Sum",
  count: "Count",
  average: "Average",
  max: "Max",
  min: "Min",
  product: "Product",
  countNums: "Count Numbers",
  stdDev: "StdDev",
  stdDevP: "StdDevP",
  var: "Var",
  varP: "VarP"
};

/** Set of all valid PivotTableSubtotal values (for runtime validation) */
export const VALID_SUBTOTALS: ReadonlySet<string> = new Set<string>(
  Object.keys(METRIC_DISPLAY_NAMES)
);

/**
 * Data field configuration for pivot table aggregation.
 * Defines how values are aggregated in the pivot table.
 */
export interface DataField {
  /** Display name for the data field (e.g., "Sum of Sales") */
  name: string;
  /** Index of the source field in cacheFields */
  fld: number;
  /** Base field index for calculated fields */
  baseField?: number;
  /** Base item index for calculated fields */
  baseItem?: number;
  /** Aggregation function (default: 'sum') */
  subtotal?: PivotTableSubtotal;
  /** Number format ID (preserved on roundtrip for currency/date formatting) */
  numFmtId?: number;
}

/**
 * A pivot table chart format entry used by pivot charts.
 */
export interface PivotTableChartFormat {
  /** Chart index within the pivot chart formatting collection. */
  chart: number;
  /** Format ID referenced by c:pivotSource/c:fmtId. */
  format: number;
  /** Whether this format applies to a series. */
  series?: boolean;
  /** Preserved or generated pivotArea XML. */
  pivotAreaXml?: string;
}

/**
 * Parsed cache definition from loaded pivot table files.
 */
export interface ParsedCacheDefinition {
  sourceRef?: string;
  sourceSheet?: string;
  /** Source table name (name style - references a named Table) */
  sourceTableName?: string;
  /** Cache source type (default "worksheet") */
  cacheSourceType?: string;
  cacheFields: CacheField[];
  recordCount?: number;
  rId?: string;
  /** Additional attributes to preserve */
  refreshOnLoad?: string;
  createdVersion?: string;
  refreshedVersion?: string;
  minRefreshableVersion?: string;
  isLoaded?: boolean;
  // ----- BUG-26: Additional root attributes -----
  backgroundQuery?: string;
  supportSubquery?: string;
  supportAdvancedDrill?: string;
  /** Bag of additional root attributes not individually modeled (for roundtrip) */
  extraRootAttrs?: Record<string, string>;
  // ----- BUG-28: worksheetSource extra attributes -----
  /** worksheetSource r:id attribute (for external connections) */
  worksheetSourceRId?: string;
  // ----- BUG-29: cache definition extLst raw XML -----
  extLstXml?: string;
  // ----- R6-BugA: catch-all unknown child elements raw XML -----
  /** Preserved unknown child elements XML for roundtrip (e.g. calculatedItems, cacheHierarchies) */
  unknownElementsXml?: string;
  // ----- R8-B9: non-worksheet cacheSource children raw XML -----
  /** Preserved raw XML for non-worksheetSource children inside <cacheSource> (e.g. <consolidation>) */
  cacheSourceXml?: string;
}

/** Allowed element types within cache record values */
export type RecordValue =
  | { type: "x"; value: number }
  | { type: "n"; value: number }
  | { type: "s"; value: string }
  | { type: "b"; value: boolean }
  | { type: "m" }
  | { type: "d"; value: Date }
  | { type: "e"; value: string };

/**
 * Parsed cache records from loaded pivot table files.
 */
export interface ParsedCacheRecords {
  records: RecordValue[][];
  count: number;
  isLoaded?: boolean;
  // R8-B11: Preserved original root element attributes for roundtrip
  /** Extra root attributes beyond xmlns/xmlns:r/count (for roundtrip preservation) */
  extraRootAttrs?: Record<string, string>;
}
