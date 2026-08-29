/**
 * Shared layout constants for the layout / pagination / SVG render modules.
 *
 * These defaults are used when a `SectionProperties` does not specify a
 * page size or margin. Keeping them in a single file avoids drift between
 * `layout.ts`, `layout-full.ts`, and `render-page.ts`.
 *
 * The values match Microsoft Word's defaults for US Letter paper:
 *   - Page size: 8.5 in × 11 in (12240 × 15840 twips)
 *   - Margins:   1 in on all sides (1440 twips)
 */

import type {
  ParagraphProperties,
  RunProperties,
  Table,
  TableCellProperties,
  TableProperties,
  TableWidth
} from "@word/types";

/** Default page width in twips (US Letter, 8.5 in). */
export const DEFAULT_PAGE_WIDTH_TWIPS = 12240;

/** Default page height in twips (US Letter, 11 in). */
export const DEFAULT_PAGE_HEIGHT_TWIPS = 15840;

/** Default page margin in twips (1 in on each side). */
export const DEFAULT_PAGE_MARGIN_TWIPS = 1440;

/**
 * Default body font size in points, for a run whose size no style in its chain
 * declares.
 *
 * Word's own default is 11pt Calibri. Keeping this in one place matters because
 * the paginator, the positioner and the SVG renderer all have to agree on the
 * height of a size-less run: when they disagreed, the page each item was
 * assigned to no longer matched the space it actually occupied.
 */
export const DEFAULT_FONT_SIZE_PT = 11;

/** Default body font size in half-points (the unit `w:sz` uses). */
export const DEFAULT_FONT_SIZE_HALF_PT = DEFAULT_FONT_SIZE_PT * 2;

/**
 * Natural (single-spaced) line height as a multiple of the font size.
 *
 * Word derives a line's natural height from the font metrics of the largest run
 * on that line, not from a document-wide constant. 1.2 is the usual
 * approximation for the Latin faces we ship metrics for.
 */
export const LINE_HEIGHT_FACTOR = 1.2;

/**
 * Rendered size of a superscript/subscript, as a fraction of its source size.
 *
 * Kept beside {@link SCRIPT_BASELINE_SHIFT_FACTOR}: the two describe one effect,
 * and measurement, line extents and drawing all have to apply both.
 */
export const SCRIPT_FONT_SIZE_RATIO = 0.65;

/** Baseline rise/drop for a superscript/subscript, relative to its rendered size. */
export const SCRIPT_BASELINE_SHIFT_FACTOR = 0.33;

// =============================================================================
// Table cell margins
// =============================================================================

/**
 * The four inner margins of a table cell, in twips.
 *
 * Word calls these cell margins (`w:tblCellMar` on the table, `w:tcMar` per
 * cell); CSS would call them padding. They set both how far the content is inset
 * from the cell's borders and how tall the row has to be, so the paginator and
 * the positioner have to derive them identically — hence one resolver here
 * rather than a hardcoded guess in each.
 */
export interface CellMarginsTwips {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Word's defaults when a table declares no `w:tblCellMar`: 0.05 inch left and
 * right, nothing top and bottom.
 */
export const DEFAULT_CELL_MARGINS_TWIPS: CellMarginsTwips = {
  top: 0,
  right: 108,
  bottom: 0,
  left: 108
};

/**
 * Resolve one `w:tblCellMar` / `w:tcMar` entry to twips.
 *
 * `type: "nil"` is an explicit zero. Cell margins are always authored in twips
 * (`dxa`), so any other unit is ignored rather than misread as a twip count.
 */
function marginTwips(width: TableWidth | undefined, fallback: number): number | undefined {
  if (!width) {
    return undefined;
  }
  if (width.type === "nil") {
    return 0;
  }
  return width.type === "dxa" ? width.value : fallback;
}

/**
 * Resolve a cell's effective inner margins in twips: the cell's own `w:tcMar`
 * wins, otherwise the table's `w:tblCellMar`, otherwise Word's defaults.
 */
export function resolveCellMarginsTwips(
  tableProps: TableProperties | undefined,
  cellProps: TableCellProperties | undefined
): CellMarginsTwips {
  const table = tableProps?.cellMargins;
  const cell = cellProps?.margins;
  const pick = (
    own: TableWidth | undefined,
    inherited: TableWidth | undefined,
    fallback: number
  ): number => marginTwips(own, fallback) ?? marginTwips(inherited, fallback) ?? fallback;

  // `start`/`end` are the logical (bidi-aware) spellings of left/right; in the
  // left-to-right layout these engines implement they mean the same thing.
  return {
    top: pick(cell?.top, table?.top, DEFAULT_CELL_MARGINS_TWIPS.top),
    left: pick(
      cell?.left ?? cell?.start,
      table?.left ?? table?.start,
      DEFAULT_CELL_MARGINS_TWIPS.left
    ),
    bottom: pick(cell?.bottom, table?.bottom, DEFAULT_CELL_MARGINS_TWIPS.bottom),
    right: pick(
      cell?.right ?? cell?.end,
      table?.right ?? table?.end,
      DEFAULT_CELL_MARGINS_TWIPS.right
    )
  };
}

// =============================================================================
// Heading heuristics
// =============================================================================

/**
 * The heading level a paragraph presents as, or 0 for body text.
 *
 * `w:outlineLvl` is authoritative; a `w:pStyle` named `Heading N` is the fallback
 * for a document whose styles table is absent or incomplete.
 */
export function getHeadingLevel(props: ParagraphProperties | undefined): number {
  if (!props) {
    return 0;
  }
  if (props.outlineLevel !== undefined && props.outlineLevel >= 0 && props.outlineLevel <= 5) {
    return props.outlineLevel + 1;
  }
  if (props.style) {
    const match = /^[Hh]eading\s*(\d)$/i.exec(props.style);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return 0;
}

/**
 * How much larger than body text a heading of this level is drawn.
 *
 * Applied **only** when the style supplies no concrete `w:sz` — a document with a
 * styles table gets its declared sizes and this heuristic stays out of the way.
 *
 * Shared because both layout passes must agree on it. The positioned pass applied
 * it and the pagination pass did not, so a run of `Heading 1` paragraphs was
 * estimated at body height: 40 of them reported one page and paginated to two, and
 * `pageCount` is what `NUMPAGES`, `PAGE`, TOC entries and `PAGEREF` are resolved
 * from — so the page numbers written into the document were a quarter of the truth.
 */
export function getHeadingFontScale(level: number): number {
  switch (level) {
    case 1:
      return 2.0;
    case 2:
      return 1.5;
    case 3:
      return 1.17;
    case 4:
      return 1.0;
    case 5:
      return 0.83;
    case 6:
      return 0.67;
    default:
      return 1.0;
  }
}

/**
 * The heading scale in force for a paragraph, given its resolved style run props.
 *
 * The single expression both passes use, so neither can forget the `w:sz` opt-out.
 */
export function resolveHeadingScale(
  paragraphProps: ParagraphProperties | undefined,
  styleRunSize: number | null | undefined
): number {
  return styleRunSize != null ? 1 : getHeadingFontScale(getHeadingLevel(paragraphProps));
}

/**
 * Slack allowed when asking whether a block still fits on the page.
 *
 * Heights accumulate by repeated addition, so a page that should be filled exactly
 * comes up a few ulps short: fourteen 43.2pt paragraphs sum to 604.80000000000007,
 * leaving 43.199999999999932 for a fifteenth that measures 43.2 — and the block was
 * pushed to the next page over 7e-14pt. That is invisible on the page and visible in
 * `pageCount`, which `NUMPAGES`, `PAGE`, TOC entries and `PAGEREF` are resolved from.
 *
 * A hundredth of a point is far below anything a document can express (a twip, the
 * finest OOXML unit, is 0.05pt) and far above the accumulated error.
 */
export const FIT_EPSILON_PT = 0.01;

// =============================================================================
// Run property inheritance
// =============================================================================

/**
 * Merge a run's own properties over the ones it inherits.
 *
 * `w:rFonts` is merged **per slot**, not replaced whole. A spread — `{...inherited,
 * ...own}` — throws away the inherited `w:ascii` the moment a run names only
 * `w:eastAsia`, which is how a Chinese run overriding just its East Asian face is
 * written. Word resolves each attribute of `w:rFonts` independently, so the Latin
 * face from the style chain has to survive.
 *
 * The pagination pass papered over this by threading the inherited Latin name
 * through a separate parameter; the positioned pass had nothing and fell back to
 * Calibri, measuring the Latin half of every such run against the wrong face —
 * narrower than the truth, so the two passes disagreed about page count in the
 * direction that writes a wrong `NUMPAGES` into the document.
 */
export function mergeRunProperties(
  inherited: RunProperties | undefined,
  own: RunProperties | undefined
): RunProperties | undefined {
  if (!inherited) {
    return own;
  }
  if (!own) {
    return inherited;
  }
  const merged: RunProperties = { ...inherited, ...own };
  if (inherited.font !== undefined && own.font !== undefined) {
    const a = typeof inherited.font === "string" ? { ascii: inherited.font } : inherited.font;
    const b = typeof own.font === "string" ? { ascii: own.font } : own.font;
    return { ...merged, font: { ...a, ...b } };
  }
  return merged;
}

// =============================================================================
// Table geometry
// =============================================================================

/**
 * Column widths in twips, scaled to the measure the table is laid into.
 *
 * `w:tblGrid` is advisory: Word fits the grid to the available width, shrinking a
 * table whose columns overflow and expanding one that under-fills. The pagination
 * pass used the declared twips as-is, so a table arriving from the Excel or HTML
 * bridge with a grid twice the page width was estimated with columns twice as wide
 * as they are drawn — half the wrapped lines, and a page count short of the truth.
 *
 * Returns equal columns when no usable grid is declared.
 */
export function resolveColumnWidthsTwips(
  table: Table,
  numCols: number,
  availableWidthTwips: number
): number[] {
  if (numCols <= 0) {
    return [];
  }
  const declared = table.columnWidths;
  if (declared && declared.length >= numCols) {
    const widths = declared.slice(0, numCols);
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const scale = availableWidthTwips / total;
      return widths.map(w => w * scale);
    }
  }
  return new Array<number>(numCols).fill(availableWidthTwips / numCols);
}

/**
 * The shortest a table row can be, in points.
 *
 * One line of body text plus the row's own cell margins. The two passes had
 * different answers — the pagination pass used a line height plus the margins while
 * the positioned pass hardcoded `11 × 1.5 = 16.5pt` and ignored the margins — so a
 * compact table of single-line cells was estimated 3.3pt per row short. Forty rows
 * of that is a page.
 */
export function minimumRowHeightPt(
  tableProperties: TableProperties | undefined,
  defaultFontSizePt: number
): number {
  const margins = resolveCellMarginsTwips(tableProperties, undefined);
  return defaultFontSizePt * LINE_HEIGHT_FACTOR + (margins.top + margins.bottom) / 20;
}
