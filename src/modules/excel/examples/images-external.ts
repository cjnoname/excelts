/**
 * Example: External (linked) images
 *
 * By default `workbook.addImage({ buffer | base64 | filename })` EMBEDS the
 * image bytes inside the .xlsx package (`xl/media/imageN.ext`). Passing a
 * `link` instead references the image EXTERNALLY — Excel stores only a
 * relationship (`TargetMode="External"`) and a `<a:blip r:link>`, so no bytes
 * are written into the file and its size stays small.
 *
 * Covers:
 * - Linked picture placed in a cell range (`ws.addImage`)
 * - Linked overlay watermark (`ws.addWatermark({ mode: "overlay" })`)
 * - Embedded-vs-linked file-size comparison
 *
 * The `link` may be:
 * - a local file path as a `file://` URL, e.g. `"file:///C:/images/logo.png"`, or
 * - an http(s) URL, e.g. `"https://example.com/logo.png"`.
 *
 * IMPORTANT — why a linked image may show "The linked image cannot be displayed":
 * - A `file://` link only resolves if that file actually exists on the machine
 *   opening the workbook. This example links the REAL bundled PNG by absolute
 *   path so it renders on the machine that generated it.
 * - Excel desktop does NOT auto-download http(s) image links by default (a
 *   security measure). Such links show a placeholder even when the URL is valid.
 *   This is Excel behaviour, not a defect in the generated file.
 *
 * Other caveats:
 * - Linked images are volatile: if the target moves or the workbook is sent to
 *   someone else, Excel shows a broken-image placeholder. Embed for portability.
 * - Only cell pictures and overlay watermarks may be external. Worksheet
 *   BACKGROUND images and HEADER/FOOTER (VML) watermarks cannot be linked —
 *   `addBackgroundImage` / `addWatermark({ mode: "header" })` throw if given a
 *   linked image (Excel drops such backgrounds on open). Use an embedded image.
 *
 * Run: `pnpm example --filter images-external` (writes into `tmp/excel-examples/`).
 * To choose the output path, invoke the file directly and pass it:
 * `node --import @oxc-node/core/register src/modules/excel/examples/images-external.ts out.xlsx`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { Cell, Image, Watermark, Workbook } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

// Output file: passed via argv, otherwise written under the project tmp/excel-examples dir.
const filename =
  process.argv[2] ?? path.join(exampleDir, "../../../../tmp/excel-examples/images-external.xlsx");
fs.mkdirSync(path.dirname(filename), { recursive: true });

// A small real PNG bundled with the examples.
const localPng = path.join(exampleDir, "data/image2.png");

// `file://` URL pointing at that REAL local file — renders on this machine.
const LOCAL_FILE_URL = pathToFileURL(localPng).href;

// A publicly reachable http(s) URL (the same PNG, served from the repo).
// NOTE: Excel desktop will NOT auto-download this — it shows a placeholder by
// design. The relationship in the .xlsx is still correct.
const REMOTE_URL =
  "https://raw.githubusercontent.com/documonster/documonster/main/src/modules/excel/examples/data/image2.png";

// ---------------------------------------------------------------------------
// 1. A workbook with EXTERNAL (linked) images — no bytes embedded.
// ---------------------------------------------------------------------------
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "linked-images");

Cell.setValue(ws, "A1", "Linked images are referenced, not embedded — the file stays small.");
Cell.setValue(
  ws,
  "A2",
  "Left: local file:// link (renders here). Right: https link (Excel blocks auto-download)."
);

// (a) A linked picture from a REAL local file — this one displays on this machine.
const localLinkId = Image.add(wb, { extension: "png", link: LOCAL_FILE_URL });
Image.place(ws, localLinkId, "B4:E11");

// (b) A linked picture from an http(s) URL — valid rel, but Excel won't fetch it.
const urlImageId = Image.add(wb, { extension: "png", link: REMOTE_URL });
Image.place(ws, urlImageId, "G4:J11");

// (c) A linked overlay watermark on a second sheet (transparency via opacity).
const wmSheet = Workbook.addWorksheet(wb, "linked-watermark");
Cell.setValue(wmSheet, "A1", "This sheet has a linked overlay watermark.");
const wmImageId = Image.add(wb, { extension: "png", link: LOCAL_FILE_URL });
Watermark.add(wmSheet, { imageId: wmImageId, mode: "overlay", opacity: 0.15 });

// The following would THROW — background and header watermarks must be embedded:
//   wmSheet.addWatermark({ imageId: wmImageId, mode: "header" });
//   ws.addBackgroundImage(wmImageId);
//   // ImageError: ...cannot be external (linked) images.

const stopwatch = new HrStopwatch();
stopwatch.start();
try {
  await Workbook.writeFile(wb, filename);
  console.log("Done. Wrote linked-image workbook to:", filename);
  console.log("Time taken (us):", stopwatch.microseconds);
} catch (error) {
  console.error((error as Error).stack);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Size comparison: embedded vs linked.
// ---------------------------------------------------------------------------
const embeddedWb = Workbook.create();
const embeddedWs = Workbook.addWorksheet(embeddedWb, "embedded");
const embeddedId = Image.add(embeddedWb, {
  buffer: fs.readFileSync(localPng),
  extension: "png"
});
Image.place(embeddedWs, embeddedId, "B3:E10");
const embeddedBytes = new Uint8Array(await Workbook.toBuffer(embeddedWb));

const linkedBytes = fs.statSync(filename).size;
console.log("");
console.log("Size comparison (single image):");
console.log(`  embedded workbook: ${embeddedBytes.length} bytes`);
console.log(`  linked   workbook: ${linkedBytes} bytes (2 sheets, but no image bytes)`);
