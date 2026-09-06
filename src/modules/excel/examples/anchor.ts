/**
 * Example: Excel — Anchor namespace (drawing anchor handle API)
 *
 * Demonstrates the `Anchor` namespace, the plain-data drawing-anchor handle
 * (a cell coordinate plus an EMU offset) used to position images/drawings:
 * - Anchor.create(ws, "B2")     — build an anchor from a worksheet + address
 * - Anchor.col(a) / Anchor.row(a)        — read fractional col/row position
 * - Anchor.setCol(a, v) / Anchor.setRow(a, v) — set fractional col/row position
 * - Anchor.colWidth(a) / Anchor.rowHeight(a)  — resolved EMU width/height
 * - Anchor.clone(a)             — duplicate an anchor (optionally rebinding ws)
 *
 * The console section exercises the handle methods directly; the workbook
 * section uses two anchors as the top-left / bottom-right of a two-cell image
 * anchor via Image.place.
 *
 * Usage:   pnpm example --filter anchor
 * Output:  tmp/excel-examples/anchor.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Anchor, Cell, Image, Workbook } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "anchor.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Anchors");

// =============================================================================
// 1. Create anchors and read their position
// =============================================================================

console.log("=== 1. Anchor.create / col / row ===");

// From an A1-style address. Column B = index 1, row 2 = index 1 (0-based).
const a1 = Anchor.create(ws, "B2");
console.log('Anchor "B2": col =', Anchor.col(a1), "row =", Anchor.row(a1));

// From a { col, row } simple address (0-based).
const a2 = Anchor.create(ws, { col: 4, row: 3 });
console.log("Anchor {col:4,row:3}: col =", Anchor.col(a2), "row =", Anchor.row(a2));

// Resolved EMU width/height for the anchored cell (defaults when not custom).
console.log("colWidth (EMU):", Anchor.colWidth(a1), "rowHeight (EMU):", Anchor.rowHeight(a1));

// =============================================================================
// 2. Mutate position with setCol / setRow (supports fractional offsets)
// =============================================================================

console.log("\n=== 2. Anchor.setCol / setRow ===");

const moving = Anchor.create(ws, "A1");
Anchor.setCol(moving, 2.5); // half-way into column C (index 2)
Anchor.setRow(moving, 1.25); // a quarter into row 2 (index 1)
console.log(
  "After setCol(2.5)/setRow(1.25): col =",
  Anchor.col(moving),
  "row =",
  Anchor.row(moving)
);

// =============================================================================
// 3. Clone an anchor
// =============================================================================

console.log("\n=== 3. Anchor.clone ===");

const original = Anchor.create(ws, "C3");
const copy = Anchor.clone(original);
Anchor.setCol(copy, 9); // mutate the clone only
console.log("Original col:", Anchor.col(original), "(unchanged)");
console.log("Clone col:", Anchor.col(copy));

// =============================================================================
// 4. Use anchors as a two-cell image anchor (tl + br)
// =============================================================================

console.log("\n=== 4. Two-cell image anchor via Image.place ===");

Cell.setValue(ws, "B2", "Image spans B2:E10");

const imageId = Image.add(wb, {
  filename: path.join(exampleDir, "data/image2.png"),
  extension: "png"
});

// Top-left anchored at B2, bottom-right at E10 — the image scales with the
// cells between the two anchors.
const tl = Anchor.create(ws, "B2");
const br = Anchor.create(ws, "E10");

// Image.place's surface anchor type is the fractional { col, row } form, so
// project each Anchor handle through Anchor.col / Anchor.row.
Image.place(ws, imageId, {
  tl: { col: Anchor.col(tl), row: Anchor.row(tl) },
  br: { col: Anchor.col(br), row: Anchor.row(br) }
});
console.log("Placed image with tl col/row:", Anchor.col(tl), Anchor.row(tl));
console.log("                  br col/row:", Anchor.col(br), Anchor.row(br));

try {
  await writeBothFormats(wb, filename);
  console.log("\nWrote:", filename);
} catch (error) {
  console.error((error as Error).stack);
}
