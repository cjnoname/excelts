/**
 * What makes a hyperlink *internal*, in one place.
 *
 * A link within the workbook is spelled `#'Sheet Name'!A1` in the model, and the distinction decides how it is written
 * in both containers: OOXML puts it in `<hyperlink location="…">` with **no** relationship, and BIFF12 puts it in
 * `BrtHLink`'s location field with an empty relationship id.
 *
 * **This lives here because three writers ask the question and the answer has to be one answer.** `xlsx/xform/sheet/`
 * owned it, `stream/sheet-rels-writer.ts` imported it from there, and the XLSB writer asked it again with its own
 * `startsWith("#")` — which is how the XLSB path came to allocate a relationship for every link and turn `#Linked!A1`
 * into an *external* URL that navigated nowhere. Excel's own save of the same workbook carries no hyperlink
 * relationship at all.
 *
 * Layer 4 `core/` rather than either writer's tree, so `xlsb/` can reach it without a sideways import.
 */

/** Whether `target` names a place inside the workbook rather than an external resource. */
export function isInternalLink(target: string): boolean {
  return target.startsWith("#");
}

/**
 * The `location` an internal link declares, without the leading `#`.
 *
 * Returns `undefined` for an external target, so a caller writes the relationship instead — the two are exclusive and
 * this is the seam that says so.
 */
export function internalLinkLocation(target: string): string | undefined {
  return isInternalLink(target) ? target.slice(1) : undefined;
}
