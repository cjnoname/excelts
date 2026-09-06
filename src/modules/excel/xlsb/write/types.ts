/**
 * The shapes the part writers in this directory take.
 *
 * Separated from `emit.ts` because the two answer different questions and one of them has no runtime
 * behaviour at all. `emit.ts` is the point at which a record name becomes an id by asking the spec
 * table — that is a mechanism, and it is worth being able to point at. These are a data contract:
 * `SheetCell`, `SheetRow` and `SheetColumn` are named by the worksheet writer, produced by the model
 * adapter and consumed by the cell encoder, so putting them beside any one of those three would make
 * the other two import from a module whose name says it does something else. Keeping them here also
 * keeps the dependency edges type-only, which is what stops a low-level encoder and a high-level
 * adapter from being able to close a cycle through the emitter.
 */
import type { Alignment, Borders, CellValue, Fill, Font, Protection } from "@excel/types";

/**
 * The formatting a cell, a row or a column can ask for.
 *
 * All three reference their format through an `ixfe`/`iStyleRef` in the same way, so all three carry the
 * same five fields — and each of the three intern sites listed them again. A sixth facet meant editing
 * three places and hoping, which is how a facet comes to be written for cells and dropped for rows.
 *
 * Deliberately *not* the public `Style`: its fields are required, its `numFmt` admits an id-and-code
 * pair, and it carries `styleName` — which this writer does not express. A `Pick<Partial<Style>>` would
 * say the same thing less clearly and imply support that is not there.
 */
export interface StyleFacets {
  /**
   * Number format string, interned into the cell-format table as the part is written.
   *
   * Carried as the format itself rather than as an index because the index only exists once the table has
   * seen every cell, and a caller building a row has no way to know it.
   */
  readonly numberFormat?: string;
  readonly font?: Partial<Font> | undefined;
  readonly fill?: Fill | undefined;
  readonly border?: Partial<Borders> | undefined;
  readonly alignment?: Partial<Alignment> | undefined;
  readonly protection?: Partial<Protection> | undefined;
}

/** A cell as the worksheet writer needs it: a position, a value, and the formatting it asked for. */
export interface SheetCell extends StyleFacets {
  readonly row: number;
  readonly column: number;
  readonly value: CellValue;
  readonly styleIndex?: number;
  /** Formula text. `value` is then the cached result Excel shows until it recalculates. */
  readonly formula?: string;
  /** Whether the workbook uses the 1904 epoch, which a date serial is relative to. */
  readonly date1904?: boolean;
  /**
   * Address of the master cell whose shared or array formula this cell follows.
   *
   * Present *instead of* `formula`: a follower stores no expression, only a `PtgExp` naming the master. The
   * model spells it as an address (`"A1"`), which is exactly what the token needs once decoded.
   */
  readonly sharedFormula?: string;
  /** `"shared"` or `"array"` on the *master* cell of a filled range; the range is then in `ref`. */
  readonly shareType?: string;
  /** The range a shared or array formula covers, on the master cell. */
  readonly ref?: string;
  /** Name of the feature this cell needs and the writer lacks, reported rather than approximated. */
  readonly unsupported?: string;
}

/** A row as the worksheet writer needs it. */
export interface SheetRow extends StyleFacets {
  readonly row: number;
  readonly cells: readonly SheetCell[];
  /** Row height in points. Omitted means the sheet default. */
  readonly heightPoints?: number;
}

/** A column's width and formatting, as the worksheet part carries it. */
export interface SheetColumn extends StyleFacets {
  /** Zero-based, inclusive. */
  readonly firstColumn: number;
  readonly lastColumn: number;
  /** Width in characters, the unit the public API uses. */
  readonly widthCharacters: number;
  /** `fHidden`. */
  readonly hidden?: boolean;
  /** `fBestFit` — the width was chosen to fit the widest cell. */
  readonly bestFit?: boolean;
  /** `iOutLevel`, 0–7. */
  readonly outlineLevel?: number;
  /** `fCollapsed`. */
  readonly collapsed?: boolean;
  /**
   * Whether `widthCharacters` is the author's or a stand-in.
   *
   * `fUserSet` tells Excel to keep a width rather than recompute it, so it must not be set for a column that
   * only carries flags — otherwise a hidden column with no width would pin itself to the default.
   */
  readonly widthWasSet?: boolean;
}

/** A sheet as the workbook part declares it. */
export interface SheetEntry {
  readonly name: string;
  readonly state?: "visible" | "hidden" | "veryHidden";
  /**
   * The workbook relationship that reaches this sheet's part.
   *
   * Carried rather than derived from the bundle position, because a chartsheet follows the worksheets in
   * the relationship sequence — deriving it pointed every chartsheet at a worksheet.
   */
  readonly relationshipId?: string;
}

/** The subset of a `CellModel` these writers read. */
export interface CellLike {
  readonly address: string;
  readonly style?: {
    readonly numFmt?: string | { readonly formatCode: string };
    readonly font?: Partial<Font>;
    readonly fill?: Fill;
    readonly border?: Partial<Borders>;
    readonly alignment?: Partial<Alignment>;
    readonly protection?: Partial<Protection>;
  };
  readonly value?: unknown;
  readonly formula?: string;
  readonly sharedFormula?: string;
  readonly result?: unknown;
  readonly richText?: unknown;
  readonly error?: unknown;
  readonly hyperlink?: string;
  /**
   * Display text of a hyperlink cell.
   *
   * A sibling of `hyperlink`, not nested in `value` — which is empty for such a cell. The first version
   * of this looked for `value.hyperlink` and found nothing, so every hyperlink cell was written blank
   * while its link was written correctly beside it.
   */
  readonly text?: string;
  /** `"array"` for an array formula; the spill range is then in `ref`. */
  readonly shareType?: string;
  /** Spill range of an array formula. */
  readonly ref?: string;
  /** Whether the formula is a dynamic array, which spills without being declared as one. */
  readonly isDynamicArray?: boolean;
  /** Model discriminant. Only consulted for the shared-string shape, whose `value` is an index. */
  readonly type?: number;
}
