/**
 * The order sheets appear on the tab bar, decided once for both containers.
 *
 * A workbook keeps worksheets and chartsheets in two arrays, so the order the author actually chose — which may
 * interleave them — is not recoverable from either array alone. It lives in `orderNo`, a counter allocated across
 * both families as sheets are added.
 *
 * **This existed only inside the XLSX writer's `prepare`, and the XLSB writer therefore invented its own answer**:
 * every worksheet, then every chartsheet. For `financial-report`, whose chartsheet is the *first* tab, that put
 * "Board View" last — the seventh entry in the "one model, two writers" list in the README, and the same shape as
 * the six before it. The rule is not that the XLSB writer was wrong to append; it is that a decision about the
 * model was being made twice.
 *
 * The three-level comparison is not decoration, and each level earns its place:
 *
 * 1. **`orderNo`** when a sheet has one. It is the only field that means tab order.
 * 2. **`sheetNo`** when it does not. That is the file-path number and it is allocated *per family*, so it is a
 *    correct tie-break only between sheets of the same kind — which is exactly the case it is reached in, because
 *    a sheet that came from a reader has no `orderNo` while one added through the API does. In `financial-report`
 *    the seven worksheets fall back to `sheetNo` 1–7 and the chartsheet carries `orderNo` 0, which is what makes
 *    it first.
 * 3. **Position in the combined list**, so the sort is stable and two sheets that compare equal keep the order
 *    they were handed in rather than swapping between engine versions.
 */

/** The fields this ordering reads. Anything with them can be ordered; nothing else is required. */
export interface OrderableSheet {
  readonly orderNo?: number;
  readonly sheetNo?: number;
}

/**
 * Worksheets and chartsheets in tab order.
 *
 * Returns the worksheets unchanged when there are no chartsheets. That is not an optimisation — it is the case
 * where the two arrays cannot disagree, and short-circuiting it means a workbook without chartsheets cannot be
 * reordered by a defect in this function.
 */
export function sheetsInTabOrder<TSheet extends OrderableSheet>(
  worksheets: readonly TSheet[],
  chartsheets: readonly TSheet[]
): readonly TSheet[] {
  if (chartsheets.length === 0) {
    return worksheets;
  }
  return [...worksheets, ...chartsheets]
    .map((sheet, position) => ({ sheet, position }))
    .sort((left, right) => {
      const difference = tabPosition(left.sheet) - tabPosition(right.sheet);
      return difference !== 0 ? difference : left.position - right.position;
    })
    .map(entry => entry.sheet);
}

/** A sheet's tab position, or `Infinity` when it states neither — which sorts it last rather than throwing. */
function tabPosition(sheet: OrderableSheet): number {
  if (typeof sheet.orderNo === "number") {
    return sheet.orderNo;
  }
  if (typeof sheet.sheetNo === "number") {
    return sheet.sheetNo;
  }
  return Infinity;
}
