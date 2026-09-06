/**
 * BIFF12 validation problem vocabulary.
 *
 * Mirrors `utils/ooxml-validator/types.ts` deliberately: the two validators answer
 * the same question about two encodings of the same document, and a caller that has
 * learned one report shape should not have to learn a second.
 *
 * Adding a kind is additive. Removing or renaming one is a breaking change, because
 * callers switch on these.
 */

/** Problems with the package around the binary parts. */
export type XlsbPackageKind =
  | "package-missing-workbook"
  | "package-missing-content-types"
  | "package-missing-part"
  /**
   * A relationship naming a part the package does not contain.
   *
   * The fault is in the space *between* parts, which is why every per-part check passed while Excel discarded a
   * drawing whose relationship pointed at a `chartEx` part the XLSB writer never wrote.
   */
  | "package-dangling-relationship"
  /**
   * A relationship type differing from a known one only by case.
   *
   * Type URIs are compared case-sensitively while part names are not, and that asymmetry is what made a
   * hand-written `chartex` (for `chartEx`) cost a whole drawing part.
   */
  | "package-relationship-type-case"
  | "package-wrong-content-type"
  | "package-unreadable";

/** Problems with the record framing of a `.bin` part. */
export type XlsbFramingKind =
  | "framing-truncated-header"
  | "framing-payload-overrun"
  /** A record whose length differs from the one Excel always writes. See `OBSERVED_PAYLOAD_SIZES`. */
  | "framing-unexpected-payload-size"
  | "framing-trailing-bytes"
  | "framing-empty-part";

/** Problems with `Begin`/`End` nesting. */
export type XlsbScopeKind =
  | "scope-unclosed"
  | "scope-unopened"
  | "scope-mismatched"
  | "scope-missing-root";

/** Problems with where a record appears relative to others. */
export type XlsbOrderingKind =
  | "ordering-out-of-place"
  | "ordering-outside-scope"
  /** A record every reference workbook contains is absent. See `requiredRecords`. */
  | "record-missing-required";

/** Problems with an index into a counted collection. */
export type XlsbIndexKind =
  | "index-shared-string-out-of-range"
  | "index-style-out-of-range"
  | "index-count-mismatch"
  /**
   * A conditional-formatting rule naming a differential format the styles part does not declare.
   *
   * Cross-part, like a dangling relationship: the rule is in a worksheet and the table it indexes is in
   * `styles.bin`, so neither part alone is wrong. Excel reports `Repaired Records: Conditional formatting`.
   */
  | "index-dxf-out-of-range"
  /**
   * A `BrtXF` in the style-XF collection declaring a parent.
   *
   * `ixfParent` indexes that same collection, so a style XF must be a root (0xFFFF). Excel discards every named
   * style in the workbook otherwise — and reports the Styles collection, not the XFs.
   */
  | "index-style-xf-has-parent";

/** Problems with a cell coordinate or a declared range. */
export type XlsbCoordinateKind =
  | "coordinate-row-out-of-range"
  | "coordinate-column-out-of-range"
  | "coordinate-range-inverted"
  | "coordinate-dimension-mismatch"
  | "coordinate-row-out-of-order";

export type XlsbProblemKind =
  | XlsbPackageKind
  | XlsbFramingKind
  | XlsbScopeKind
  | XlsbOrderingKind
  | XlsbIndexKind
  | XlsbCoordinateKind;

/**
 * How much a problem matters.
 *
 * `error` means Excel refuses the file or offers to repair it. `warning` means the
 * package violates an invariant but will probably open — reported only when asked
 * for, and never affecting `ok`.
 */
export type XlsbSeverity = "error" | "warning";

export interface XlsbProblem {
  readonly severity: XlsbSeverity;
  readonly kind: XlsbProblemKind;
  readonly message: string;
  /** Part the problem is in, e.g. `xl/worksheets/sheet1.bin`. */
  readonly part?: string;
  /** Byte offset of the record at fault, where one applies. */
  readonly offset?: number;
}

export interface XlsbValidationReport {
  readonly ok: boolean;
  readonly problems: readonly XlsbProblem[];
  /** True when the problem list was cut short by `maxProblems`. */
  readonly capped: boolean;
  readonly stats: {
    readonly partCount: number;
    readonly binaryPartCount: number;
    readonly recordCount: number;
    readonly unknownRecordCount: number;
  };
}

export interface XlsbValidateOptions {
  /** Check `Begin`/`End` nesting. Default `true`. */
  readonly checkScopes?: boolean;
  /** Check record ordering within a part. Default `true`. */
  readonly checkOrdering?: boolean;
  /** Check indexes into shared strings and cell formats. Default `true`. */
  readonly checkIndexes?: boolean;
  /** Check cell coordinates and declared ranges. Default `true`. */
  readonly checkCoordinates?: boolean;
  /** Include `warning` problems. Default `false`. */
  readonly includeWarnings?: boolean;
  /** Stop after this many problems. Default `100`. */
  readonly maxProblems?: number;
}
