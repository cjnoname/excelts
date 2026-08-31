/**
 * Images in a binary workbook.
 *
 * Run: `pnpm example --filter xlsb-images`
 *
 * **A picture in a `.xlsb` is stored exactly as it is in a `.xlsx`.** The bytes go in `xl/media/`,
 * the placement in `xl/drawings/drawingN.xml`, and the worksheet reaches the drawing through its own
 * `.rels`. Only one thing about it is binary: a twelve-byte `BrtDrawing` record in the sheet's stream
 * carrying the relationship id and nothing else.
 *
 * So the drawing XML, the anchor arithmetic and the media parts are the *same code* the XLSX path
 * uses — and the drawing part this example writes is byte-for-byte identical to the one the same
 * workbook produces as `.xlsx`. That is worth stating as a property rather than a hope: two
 * serialisers for one XML schema would be two things to keep in step, and the one with fewer users
 * would be the one that drifted.
 *
 * **What is not here, and why.** A sheet *background* image needs a `BrtBkHim` record, which appears
 * in none of the reference workbooks — so its layout cannot be read off Excel's output, and this
 * module does not guess one. Charts are absent for a larger version of the same reason: their XML is
 * a substantial subsystem of its own rather than a record whose bytes are in question.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Column, Image, Row, Workbook, Worksheet } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-images.xlsb");

const png = fs.readFileSync(path.join(exampleDir, "data/image2.png"));
const jpg = fs.readFileSync(path.join(exampleDir, "data/bubbles.jpg"));

const wb = Workbook.create();

// Two images in the workbook's media list; a sheet references them by id, so the same picture placed
// twice is stored once.
const pngId = Image.add(wb, { buffer: png, extension: "png" });
const jpgId = Image.add(wb, { buffer: jpg, extension: "jpeg" });

// ---------------------------------------------------------------------------
// Anchored to a rectangle of cells: the picture moves and resizes with them.
// ---------------------------------------------------------------------------

const anchored = Workbook.addWorksheet(wb, "Anchored");
Column.setWidth(anchored, 1, 30);
Cell.setValue(anchored, "A1", "Two-cell anchor — resizes with the cells");
Cell.setStyle(anchored, "A1", { font: { bold: true, size: 12 } });
Cell.setValue(anchored, "A3", "PNG, B3:E12");
Cell.setValue(anchored, "A15", "JPEG, B15:D22");

// `tl`/`br` are zero-based, so `{ col: 1, row: 2 }` is B3.
Image.place(anchored, pngId, {
  tl: { col: 1, row: 2 },
  br: { col: 5, row: 12 }
} as never);
Image.place(anchored, jpgId, {
  tl: { col: 1, row: 14 },
  br: { col: 4, row: 22 }
} as never);

// ---------------------------------------------------------------------------
// Anchored to one cell at a fixed size: it moves with the cell but does not resize.
// ---------------------------------------------------------------------------

const sized = Workbook.addWorksheet(wb, "FixedSize");
Column.setWidth(sized, 1, 30);
Cell.setValue(sized, "A1", "One-cell anchor — fixed pixel size");
Cell.setStyle(sized, "A1", { font: { bold: true, size: 12 } });

// The same image at three sizes, which is what an `ext` in pixels is for.
[
  { row: 2, width: 80, height: 60 },
  { row: 8, width: 160, height: 120 },
  { row: 18, width: 240, height: 180 }
].forEach(({ row, width, height }) => {
  Cell.setValue(sized, `A${row + 1}`, `${width}×${height} px`);
  Image.place(sized, pngId, {
    tl: { col: 1, row },
    ext: { width, height }
  } as never);
});

// ---------------------------------------------------------------------------
// The same picture twice on one sheet, to show the media stored once.
// ---------------------------------------------------------------------------

const repeated = Workbook.addWorksheet(wb, "Repeated");
Cell.setValue(repeated, "A1", "The same PNG placed four times — stored once");
Cell.setStyle(repeated, "A1", { font: { bold: true, size: 12 } });
Row.setHeight(repeated, 1, 24);
for (const [column, row] of [
  [1, 2],
  [4, 2],
  [1, 10],
  [4, 10]
] as const) {
  Image.place(repeated, pngId, {
    tl: { col: column, row },
    ext: { width: 120, height: 90 }
  } as never);
}

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

// ---------------------------------------------------------------------------
// What the package actually contains.
// ---------------------------------------------------------------------------

const written = await extractAll(fs.readFileSync(filename));
const interesting = [...written.keys()].filter(part => /media|drawing/.test(part)).sort();
console.log("image parts:");
for (const part of interesting) {
  console.log(`  ${part.padEnd(44)} ${String(written.get(part)!.data.length).padStart(7)} bytes`);
}

// The same workbook as `.xlsx`, for comparison. The drawing parts are the same bytes because they
// are produced by the same code — the containers differ only in how the *sheet* references them.
const asXlsx = await extractAll(await Workbook.toBuffer(wb));
const decoder = new TextDecoder();
for (const part of interesting.filter(name => name.endsWith(".xml") || name.endsWith(".rels"))) {
  const mine = written.get(part);
  const theirs = asXlsx.get(part);
  const identical =
    mine !== undefined &&
    theirs !== undefined &&
    decoder.decode(mine.data) === decoder.decode(theirs.data);
  console.log(`  ${part}: ${identical ? "byte-identical to the .xlsx" : "differs from the .xlsx"}`);
}

// ---------------------------------------------------------------------------
// And that they survive being read and written again.
// ---------------------------------------------------------------------------

const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const rewritten = await extractAll(
  await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" })
);
const lost = interesting.filter(part => !rewritten.has(part));
console.log(
  `after a read-modify-write: ${lost.length === 0 ? "every image part survived" : `lost ${lost.join(", ")}`}`
);
console.log(
  `sheets: ${Workbook.getWorksheets(reopened)
    .map(sheet => Worksheet.getName(sheet))
    .join(", ")}`
);
