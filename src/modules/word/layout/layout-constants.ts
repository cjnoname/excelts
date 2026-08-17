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

import type { TableCellProperties, TableProperties, TableWidth } from "@word/types";

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
