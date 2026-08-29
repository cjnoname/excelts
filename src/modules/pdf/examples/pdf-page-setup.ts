/**
 * Example: Excel Page Setup fidelity (issue #203)
 *
 * Two jobs:
 *
 *  1. **Verify issue #203 is fixed.** The report was that a small second sheet
 *     with two narrow columns came out horizontally centered on its own page.
 *     Excel starts the printed grid at the left margin unless "Center on page"
 *     is ticked, so the fix was to stop centering unconditionally.
 *
 *  2. **Prove the surrounding print settings still work.** Wiring `pageSetup`
 *     through to the renderer touched scaling, pagination, titles, headings,
 *     colour and comments, so every one of those is exercised here.
 *
 * Each check asserts on the *geometry read back out of the generated PDF*, not
 * on "it didn't throw" — then writes the PDF to `tmp/pdf-examples/` so the
 * output can also be inspected by eye.
 *
 * Run: pnpm example --filter pdf-page-setup
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { Cell, Column, Image, Row, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";
import { extractTextFromPage } from "../reader/content-interpreter";
import { PdfDocument } from "../reader/pdf-document";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// -----------------------------------------------------------------------------
// Helpers: read geometry back out of a generated PDF
// -----------------------------------------------------------------------------

interface Fragment {
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

/** Text fragments per page, with positions, in page order. */
function readPages(pdf: Uint8Array): Fragment[][] {
  const doc = new PdfDocument(pdf);
  return doc.getPages().map(page =>
    extractTextFromPage(page, doc).map(f => ({
      text: f.text,
      x: f.x,
      y: f.y,
      fontSize: f.fontSize
    }))
  );
}

/** Raw PDF bytes as a latin1 string, for structural checks. */
function raw(pdf: Uint8Array): string {
  return Buffer.from(pdf).toString("latin1");
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label} — ${detail}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

async function emit(name: string, pdf: Uint8Array): Promise<void> {
  fs.writeFileSync(path.join(outDir, name), pdf);
}

const MARGIN = 72; // documonster's default page margin, in points

// -----------------------------------------------------------------------------
// 1. Issue #203 — the reported scenario
// -----------------------------------------------------------------------------

console.log("\n=== Issue #203: narrow sheet must not be centered ===");

function issue203Workbook() {
  const wb = Workbook.create();

  // Sheet 1: wide enough to fill the page, as in the report.
  const wide = Workbook.addWorksheet(wb, "Wide");
  for (let c = 1; c <= 12; c++) {
    Column.setWidth(wide, c, 12);
    Cell.setValue(wide, 1, c, `Header ${c}`);
    for (let r = 2; r <= 8; r++) {
      Cell.setValue(wide, r, c, r * c);
    }
  }

  // Sheet 2: the two narrow columns that were coming out centered.
  const narrow = Workbook.addWorksheet(wb, "Narrow");
  Column.setWidth(narrow, 1, 14);
  Column.setWidth(narrow, 2, 12);
  Cell.setValue(narrow, 1, 1, "Key");
  Cell.setValue(narrow, 1, 2, "Value");
  for (let r = 2; r <= 6; r++) {
    Cell.setValue(narrow, r, 1, `Item ${r - 1}`);
    Cell.setValue(narrow, r, 2, r * 100);
  }
  return wb;
}

const issuePdf = await Pdf.fromExcel(issue203Workbook());
await emit("issue-203-fixed.pdf", issuePdf);

const issuePages = readPages(issuePdf);
check(
  "both sheets exported",
  issuePages.length >= 2,
  `${issuePages.length} pages (wide sheet + narrow sheet)`
);

// The heart of the issue: every page's leftmost text must sit at the left
// margin. Before the fix the narrow sheet's text started near x=231.
for (let i = 0; i < issuePages.length; i++) {
  const leftMost = Math.min(...issuePages[i].map(f => f.x));
  check(
    `page ${i + 1} starts at the left margin`,
    leftMost < MARGIN + 8,
    `leftmost text x=${leftMost.toFixed(1)} (margin ${MARGIN})`
  );
}

// Centering is still available — it is now opt-in, as in Excel.
const centeredPdf = await Pdf.fromExcel(issue203Workbook(), { horizontalCentered: true });
await emit("issue-203-opt-in-centered.pdf", centeredPdf);
const centeredNarrow = Math.min(...readPages(centeredPdf)[1].map(f => f.x));
check(
  "horizontalCentered still centers when asked",
  centeredNarrow > MARGIN + 40,
  `leftmost text x=${centeredNarrow.toFixed(1)}`
);

// …and the worksheet's own print option drives it too.
const wbSheetCentered = issue203Workbook();
Workbook.getWorksheet(wbSheetCentered, "Narrow")!.pageSetup.horizontalCentered = true;
const sheetCenteredPdf = await Pdf.fromExcel(wbSheetCentered);
await emit("issue-203-sheet-centered.pdf", sheetCenteredPdf);
const sheetPages = readPages(sheetCenteredPdf);
check(
  "per-sheet centering does not leak across sheets",
  Math.min(...sheetPages[0].map(f => f.x)) < MARGIN + 8 &&
    Math.min(...sheetPages[1].map(f => f.x)) > MARGIN + 40,
  "wide sheet left-aligned, narrow sheet centered"
);

// -----------------------------------------------------------------------------
// 2. Scaling
// -----------------------------------------------------------------------------

console.log("\n=== Scaling: fitToPage / scale / fitToWidth / fitToHeight ===");

function gridWorkbook(cols: number, rows: number, width = 12) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Grid");
  for (let c = 1; c <= cols; c++) {
    Column.setWidth(ws, c, width);
    for (let r = 1; r <= rows; r++) {
      Cell.setValue(ws, r, c, `C${c}R${r}`);
    }
  }
  return { wb, ws };
}

const pageCount = (pdf: Uint8Array) => new PdfDocument(pdf).getPages().length;

const wideGrid = gridWorkbook(20, 3).wb;
const unscaled = await Pdf.fromExcel(wideGrid, { fitToPage: false });
const fitWidth1 = await Pdf.fromExcel(wideGrid, { fitToWidth: 1 });
await emit("scaling-fit-width-1.pdf", fitWidth1);
check(
  "fitToWidth: 1 collapses a wide grid to one page",
  pageCount(unscaled) > 1 && pageCount(fitWidth1) === 1,
  `${pageCount(unscaled)} pages unscaled -> ${pageCount(fitWidth1)} page`
);

// Indivisible wide columns: 3 columns at ~60% page width occupy "1.8 pages" by
// area but pack into 3. A total-area ratio would not shrink at all.
const chunky = Workbook.create();
const chunkyWs = Workbook.addWorksheet(chunky, "Chunky");
for (let c = 1; c <= 3; c++) {
  Column.setWidth(chunkyWs, c, 48);
  Cell.setValue(chunkyWs, 1, c, `Wide ${c}`);
}
const chunkyFit = await Pdf.fromExcel(chunky, { fitToWidth: 2 });
await emit("scaling-indivisible-columns.pdf", chunkyFit);
check(
  "fitToWidth honours indivisible columns",
  pageCount(chunkyFit) <= 2,
  `3 page-hogging columns -> ${pageCount(chunkyFit)} pages with fitToWidth: 2`
);

// scale must not break fitToPage's "one page wide" promise.
const modest = gridWorkbook(5, 3, 10).wb;
const enlarged = await Pdf.fromExcel(modest, { scale: 2 });
check(
  "scale: 2 still respects fitToPage",
  pageCount(enlarged) === 1,
  `${pageCount(enlarged)} page`
);

// The sheet's own "Adjust to N%" is honoured (it used to be dropped entirely).
const { wb: pctWb, ws: pctWs } = gridWorkbook(20, 3);
pctWs.pageSetup.fitToPage = false;
pctWs.pageSetup.scale = 40;
const pctPdf = await Pdf.fromExcel(pctWb);
await emit("scaling-sheet-percent.pdf", pctPdf);
check(
  "pageSetup.scale is applied",
  pageCount(pctPdf) < pageCount(unscaled),
  `40% sheet scale -> ${pageCount(pctPdf)} pages vs ${pageCount(unscaled)} at 100%`
);

// Wrapped text is exact, not approximate.
const wrapWb = Workbook.create();
const wrapWs = Workbook.addWorksheet(wrapWb, "Wrapped");
Column.setWidth(wrapWs, 1, 18);
const long = "The quick brown fox jumps over the lazy dog and keeps running far away";
for (let r = 1; r <= 60; r++) {
  Cell.setValue(wrapWs, r, 1, `${r} ${long}`);
  Cell.setAlignment(wrapWs, `A${r}`, { wrapText: true });
}
const wrapPlain = await Pdf.fromExcel(wrapWb);
const wrapFit = await Pdf.fromExcel(wrapWb, { fitToHeight: 1 });
await emit("scaling-wrapped-fit-height.pdf", wrapFit);
check(
  "fitToHeight is exact for wrapped text",
  pageCount(wrapPlain) > 1 && pageCount(wrapFit) === 1,
  `${pageCount(wrapPlain)} pages -> ${pageCount(wrapFit)} page`
);

// -----------------------------------------------------------------------------
// 3. Page order
// -----------------------------------------------------------------------------

console.log("\n=== Page order ===");

const orderWb = gridWorkbook(20, 60).wb;
const downThenOver = readPages(await Pdf.fromExcel(orderWb, { fitToPage: false }));
const overThenDown = readPages(
  await Pdf.fromExcel(orderWb, { fitToPage: false, pageOrder: "overThenDown" })
);
await emit("page-order-down-then-over.pdf", await Pdf.fromExcel(orderWb, { fitToPage: false }));

const downPage2 = downThenOver[1].map(f => f.text);
check(
  "default order is downThenOver (Excel's default)",
  downPage2.some(t => t.startsWith("C1R")) && !downPage2.includes("C1R1"),
  "page 2 keeps column 1 but has moved past row 1"
);
check(
  "overThenDown moves right first",
  overThenDown[1].some(f => f.text.endsWith("R1")),
  "page 2 stays on row 1 but past the first column band"
);

// -----------------------------------------------------------------------------
// 4. Print titles
// -----------------------------------------------------------------------------

console.log("\n=== Print titles (absolute, independent of print area) ===");

const { wb: titleWb, ws: titleWs } = gridWorkbook(20, 3);
titleWs.pageSetup.printTitlesColumn = "A:B";
const titlePdf = await Pdf.fromExcel(titleWb, { fitToPage: false });
await emit("print-titles-columns.pdf", titlePdf);
const titlePages = readPages(titlePdf);
check(
  "title columns repeat on every horizontal page",
  titlePages.every(p => p.some(f => f.text === "C1R1") && p.some(f => f.text === "C2R1")),
  `A:B present on all ${titlePages.length} pages`
);

// Titles outside the print area still repeat, as in Excel.
const { wb: outsideWb, ws: outsideWs } = gridWorkbook(20, 3);
outsideWs.pageSetup.printArea = "E1:T3";
outsideWs.pageSetup.printTitlesColumn = "A:B";
const outsidePdf = await Pdf.fromExcel(outsideWb, { fitToPage: false });
await emit("print-titles-outside-print-area.pdf", outsidePdf);
const outsidePages = readPages(outsidePdf);
check(
  "titles outside the print area still repeat",
  outsidePages.every(p => p.some(f => f.text === "C1R1")),
  "printing E:T still shows A:B on every page"
);
check(
  "columns that are neither title nor in the print area are omitted",
  !outsidePages.flat().some(f => f.text === "C3R1"),
  "C and D absent"
);

// A band that does not start at row 1 / column A is honoured too.
const { wb: rowBandWb, ws: rowBandWs } = gridWorkbook(2, 120);
rowBandWs.pageSetup.printTitlesRow = "3:5";
const rowBandPdf = await Pdf.fromExcel(rowBandWb);
await emit("print-titles-rows-3-to-5.pdf", rowBandPdf);
const rowBandPages = readPages(rowBandPdf);
check(
  'printTitlesRow "3:5" repeats rows 3-5, not the first five',
  rowBandPages.every(p => p.some(f => f.text === "C1R3") && p.some(f => f.text === "C1R5")) &&
    !rowBandPages[1].some(f => f.text === "C1R1"),
  "rows 3-5 on every page; row 1 only on page 1"
);

// Repeated titles combined with a manual page break used to hang the export.
const { wb: breakWb, ws: breakWs } = gridWorkbook(2, 40);
breakWs.pageSetup.printTitlesRow = "1";
Row.addPageBreak(breakWs, 10);
const breakPdf = await Pdf.fromExcel(breakWb);
await emit("print-titles-with-manual-break.pdf", breakPdf);
check(
  "repeated titles + manual break terminates",
  pageCount(breakPdf) > 1,
  `${pageCount(breakPdf)} pages produced (this combination used to exhaust the heap)`
);

// -----------------------------------------------------------------------------
// 5. Row/column headings
// -----------------------------------------------------------------------------

console.log("\n=== Row and column headings ===");

const headingWb = gridWorkbook(6, 8).wb;
const headingPdf = await Pdf.fromExcel(headingWb, { showRowColHeaders: true });
await emit("row-col-headings.pdf", headingPdf);
const headingFrags = readPages(headingPdf)[0];
check(
  "column letters and row numbers are printed",
  headingFrags.some(f => f.text === "A") &&
    headingFrags.some(f => f.text === "B") &&
    headingFrags.some(f => f.text === "1"),
  "A, B and 1 present"
);

const shrunkHeadings = readPages(
  await Pdf.fromExcel(gridWorkbook(20, 3).wb, { showRowColHeaders: true })
)[0];
const headingSize = shrunkHeadings.find(f => f.text === "A")?.fontSize ?? 0;
const cellSize = shrunkHeadings.find(f => f.text === "C1R1")?.fontSize ?? 0;
check(
  "headings stay legible when the grid is shrunk to fit",
  headingSize > cellSize,
  `heading ${headingSize.toFixed(1)}pt vs cell ${cellSize.toFixed(1)}pt`
);

// -----------------------------------------------------------------------------
// 6. Black and white
// -----------------------------------------------------------------------------

console.log("\n=== Black and white ===");

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44, 0x41, 0x54, 8, 0xd7,
  0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc, 0x33, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

function colourWorkbook() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Colours");
  Cell.setValue(ws, "A1", "Red on green");
  Cell.setFont(ws, "A1", { color: { argb: "FFFF0000" } });
  Cell.setFill(ws, "A1", { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } });
  const id = Image.add(wb, { buffer: TINY_PNG, extension: "png" });
  Image.place(ws, id, { tl: { col: 1, row: 1 }, br: { col: 4, row: 6 } });
  return wb;
}

const colourPdf = await Pdf.fromExcel(colourWorkbook());
const bwPdf = await Pdf.fromExcel(colourWorkbook(), { blackAndWhite: true });
await emit("black-and-white.pdf", bwPdf);
await emit("black-and-white-colour-reference.pdf", colourPdf);

const colourOps = (pdf: Uint8Array) => {
  const text = Buffer.from(pdf).toString("latin1");
  const parts: string[] = [];
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const buf = Buffer.from(m[1], "latin1");
    try {
      parts.push(inflateSync(buf).toString("latin1"));
    } catch {
      parts.push(buf.toString("latin1"));
    }
  }
  return [...parts.join("\n").matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)\b/g)].map(
    m => [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]
  );
};

const bwColours = colourOps(bwPdf);
check(
  "every vector colour is neutral grey",
  bwColours.length > 0 &&
    bwColours.every(([r, g, b]) => Math.abs(r - g) < 0.01 && Math.abs(g - b) < 0.01),
  `${bwColours.length} colour operators, all r=g=b`
);
check(
  "colour reference PDF really is colourful",
  colourOps(colourPdf).some(([r, g, b]) => Math.abs(r - g) > 0.01 || Math.abs(g - b) > 0.01),
  "saturated operators present without the flag"
);
check(
  "raster images are converted, not covered with a black overlay",
  raw(bwPdf).includes("/ColorSpace /DeviceGray") && !raw(bwPdf).includes("/Saturation"),
  "PNG samples collapsed to DeviceGray"
);

// -----------------------------------------------------------------------------
// 7. Draft quality
// -----------------------------------------------------------------------------

console.log("\n=== Draft quality ===");

const draftPdf = await Pdf.fromExcel(colourWorkbook(), { draft: true });
await emit("draft-quality.pdf", draftPdf);
check(
  "draft omits images but keeps cell content",
  !raw(draftPdf).includes("/Subtype /Image") &&
    readPages(draftPdf)[0].some(f => f.text.includes("Red on green")),
  "no image XObject, text intact"
);

// -----------------------------------------------------------------------------
// 8. Cell errors
// -----------------------------------------------------------------------------

console.log("\n=== Cell errors ===");

function errorWorkbook() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Errors");
  Cell.setValue(ws, "A1", { error: "#DIV/0!" });
  Cell.setValue(ws, "A2", "keep me");
  return wb;
}

for (const [mode, expected] of [
  ["displayed", "#DIV/0!"],
  ["dash", "--"],
  ["NA", "#N/A"]
] as const) {
  const pdf = await Pdf.fromExcel(errorWorkbook(), { errors: mode });
  await emit(`cell-errors-${mode}.pdf`, pdf);
  const text = readPages(pdf)[0]
    .map(f => f.text)
    .join(" ");
  check(`errors: "${mode}"`, text.includes(expected), `prints ${JSON.stringify(expected)}`);
}

const blankPdf = await Pdf.fromExcel(errorWorkbook(), { errors: "blank" });
await emit("cell-errors-blank.pdf", blankPdf);
const blankText = readPages(blankPdf)[0]
  .map(f => f.text)
  .join(" ");
check(
  'errors: "blank"',
  !blankText.includes("#DIV/0!") && blankText.includes("keep me"),
  "error suppressed, neighbours kept"
);

// -----------------------------------------------------------------------------
// 9. Comments
// -----------------------------------------------------------------------------

console.log("\n=== Cell comments ===");

function commentWorkbook() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Comments");
  for (let r = 1; r <= 12; r++) {
    for (let c = 1; c <= 6; c++) {
      Cell.setValue(ws, r, c, `r${r}c${c}`);
    }
  }
  Cell.setNote(ws, "B6", "Check this number");
  Cell.setNote(ws, "D9", "Second remark");
  return wb;
}

const noComments = await Pdf.fromExcel(commentWorkbook());
check(
  "comments are not printed by default",
  !readPages(noComments)
    .flat()
    .some(f => f.text.includes("Check this number")),
  "matches Excel's default of None"
);

const atEnd = await Pdf.fromExcel(commentWorkbook(), { cellComments: "atEnd" });
await emit("comments-at-end.pdf", atEnd);
const atEndPages = readPages(atEnd);
check(
  'cellComments: "atEnd" appends an addressed list',
  atEndPages.length === 2 &&
    atEndPages[1]
      .map(f => f.text)
      .join(" ")
      .includes("B6: Check this"),
  `${atEndPages.length} pages, comments on the last one`
);

const asDisplayed = await Pdf.fromExcel(commentWorkbook(), { cellComments: "asDisplayed" });
await emit("comments-as-displayed.pdf", asDisplayed);
const asDisplayedPages = readPages(asDisplayed);
// The box wraps its body, so the text arrives as several fragments — join before
// matching rather than expecting one run.
const asDisplayedText = asDisplayedPages[0].map(f => f.text).join(" ");
check(
  'cellComments: "asDisplayed" draws boxes in place',
  asDisplayedPages.length === 1 &&
    asDisplayedText.includes("Check this") &&
    asDisplayedText.includes("Second remark"),
  `no extra page; both comments drawn on the grid`
);
check(
  'cellComments: "asDisplayed" paints the note box and cell marker',
  raw(asDisplayed).length > 0 &&
    colourOps(asDisplayed).some(([r, g, b]) => r > 0.9 && g > 0.9 && b > 0.8 && b < 0.95) &&
    colourOps(asDisplayed).some(([r, g, b]) => r > 0.7 && g < 0.1 && b < 0.1),
  "note-yellow box fill and red corner marker present"
);

// -----------------------------------------------------------------------------
// 10. Merged cells and centering interaction
// -----------------------------------------------------------------------------

console.log("\n=== Merged cells with print titles ===");

const mergeWb = Workbook.create();
const mergeWs = Workbook.addWorksheet(mergeWb, "Merged");
for (let c = 1; c <= 8; c++) {
  Column.setWidth(mergeWs, c, 10);
  Cell.setValue(mergeWs, 1, c, `H${c}`);
}
Cell.setValue(mergeWs, 2, 2, "MERGED B..F");
Worksheet.merge(mergeWs, "B2:F2");
mergeWs.pageSetup.printArea = "E1:G3";
mergeWs.pageSetup.printTitlesColumn = "A:B";
const mergePdf = await Pdf.fromExcel(mergeWb, { fitToPage: false });
await emit("merged-cells-with-titles.pdf", mergePdf);
const mergeFrags = readPages(mergePdf)[0];
const mergedFrag = mergeFrags.find(f => f.text.includes("MERGED"));
const colBFrag = mergeFrags.find(f => f.text === "H2");
check(
  "a merge spanning excluded columns starts at its own column",
  mergedFrag !== undefined && colBFrag !== undefined && Math.abs(mergedFrag.x - colBFrag.x) < 1,
  mergedFrag && colBFrag
    ? `merge x=${mergedFrag.x.toFixed(1)}, column B x=${colBFrag.x.toFixed(1)}`
    : "merge or column B missing"
);

// -----------------------------------------------------------------------------
// 11. Everything at once — a smoke test that the combination holds up
// -----------------------------------------------------------------------------

console.log("\n=== Combined settings ===");

const comboWb = Workbook.create();
const comboWs = Workbook.addWorksheet(comboWb, "Report");
for (let c = 1; c <= 10; c++) {
  Column.setWidth(comboWs, c, 11);
  Cell.setValue(comboWs, 1, c, `Col ${c}`);
  for (let r = 2; r <= 45; r++) {
    Cell.setValue(comboWs, r, c, r * c);
  }
}
Cell.setFill(comboWs, "A1", {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF4472C4" }
});
Cell.setNote(comboWs, "C5", "Reviewed by finance");
comboWs.pageSetup.printTitlesRow = "1";
comboWs.headerFooter.oddHeader = "&LCombined&R&P/&N";

const comboPdf = await Pdf.fromExcel(comboWb, {
  showRowColHeaders: true,
  showGridLines: true,
  horizontalCentered: true,
  verticalCentered: true,
  blackAndWhite: true,
  cellComments: "atEnd",
  pageOrder: "overThenDown",
  fitToWidth: 1
});
await emit("combined-settings.pdf", comboPdf);
const comboPages = readPages(comboPdf);
check(
  "all settings combined produce a readable document",
  comboPages.length >= 2 &&
    comboPages[0].some(f => f.text === "A") &&
    comboPages[comboPages.length - 1]
      .map(f => f.text)
      .join(" ")
      .includes("C5: Reviewed by finance"),
  `${comboPages.length} pages: headings on page 1, comment list at the end`
);
check(
  "combined output is still fully grey",
  colourOps(comboPdf).every(([r, g, b]) => Math.abs(r - g) < 0.01 && Math.abs(g - b) < 0.01),
  "no saturated operators"
);

// -----------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log(`PDFs written to ${outDir}`);
if (failed > 0) {
  process.exitCode = 1;
}
