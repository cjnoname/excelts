/**
 * Placing an image on a worksheet, shared by `sheet_write` and `sheet_edit`.
 *
 * The workbook API is two steps — register the bytes once against the workbook,
 * then anchor that id on a sheet — and the interesting part is the anchor, because
 * the two spellings mean genuinely different things and a caller has to be able to
 * pick:
 *
 * - **A range, `"A10:H30"`.** The picture is bound to those cells, so it moves and
 *   resizes when they do. Its own dimensions are irrelevant; the cells decide.
 * - **A single cell, `"F2"`.** The picture keeps its own size and hangs from that
 *   cell's top-left corner. This is the one that needs a real pixel size, which is
 *   why `image.ts` insists on reading one rather than defaulting.
 *
 * A model asked to "put the logo at F2" means the second; asked to "fill A10:H30
 * with the diagram" it means the first. Offering only one would silently give the
 * wrong answer to half of the requests.
 */

import { Address, Image } from "documonster/excel";
import { z } from "zod";

import { toolError } from "../errors.js";
import { summariseDiagram } from "./diagram.js";
import { imageSourceShape, toCssPixels, type ResolvedImage } from "./image.js";
import { parseRange, type SheetHandle, type WorkbookHandle } from "./spreadsheet.js";

/** A single cell reference, as opposed to a range. */
const SINGLE_CELL = /^\$?[A-Z]{1,3}\$?[1-9][0-9]*$/;

export const imageSchema = z.object({
  at: z
    .string()
    .min(1)
    .describe(
      'Where to put it. A single cell ("F2") hangs the picture from that corner at its own size; a range ("A10:H30") binds it to those cells so it moves and resizes with them.'
    ),
  ...imageSourceShape
});

/** Smallest picture worth placing, in points. Below this it rounds away to nothing. */
const MIN_PLACED_POINTS = 1;

export type ImageSpec = z.infer<typeof imageSchema>;

/**
 * Register and anchor one image.
 *
 * @returns A human description for the tool's report.
 */
export function placeImage(
  wb: WorkbookHandle,
  ws: SheetHandle,
  at: string,
  image: ResolvedImage
): string {
  const reference = at.trim().toUpperCase();
  const isCell = SINGLE_CELL.test(reference);

  // Both spellings go through the range parser, which is what enforces Excel's
  // row and column limits. Checking only the range form let `A1048577` — one row
  // past the last — reach the drawing XML as an anchor Excel cannot open, and the
  // regex above cannot express a bound of 1048576.
  parseRange(isCell ? `${reference}:${reference}` : reference);

  if (isCell && (image.width < MIN_PLACED_POINTS || image.height < MIN_PLACED_POINTS)) {
    // `toCssPixels` rounds, so a sub-point size becomes a 0×0 anchor: a picture
    // that is in the file, counts as placed, and cannot be seen.
    throw toolError.invalidInput(
      `the image would be placed at ${image.width.toFixed(2)}×${image.height.toFixed(2)} pt, which rounds away to nothing`,
      "Give a larger `width`/`height`, or omit them to use the image's own size."
    );
  }

  let imageId: number;
  try {
    imageId = Image.add(wb, { buffer: image.bytes, extension: image.mediaType });
  } catch (cause) {
    throw toolError.invalidInput(
      `the workbook rejected the image: ${cause instanceof Error ? cause.message : String(cause)}`,
      "Only PNG, JPEG and GIF can be embedded in a worksheet.",
      { cause }
    );
  }

  try {
    if (isCell) {
      // `ext` is in CSS pixels at 96 dpi — not EMU, and not points. Getting the
      // unit wrong here scales the picture by 4/3 or by 9525.
      Image.place(ws, imageId, {
        tl: reference,
        ext: { width: toCssPixels(image.width), height: toCssPixels(image.height) },
        editAs: "oneCell"
      });
    } else {
      // `editAs: "twoCell"` is what makes a range anchor mean what this tool
      // promises. Passing the range as a bare string defaults it to `oneCell`,
      // which moves the picture with its cells but does **not** resize it — so the
      // documented "moves and resizes with them" was half false, and a caller who
      // widened a column got a picture that no longer fitted the block it was
      // placed in. The corners are given explicitly because the string form is
      // what carries the `oneCell` default.
      const window = parseRange(reference);
      Image.place(ws, imageId, {
        tl: { col: window.left - 1, row: window.top - 1 },
        br: { col: window.right, row: window.bottom },
        editAs: "twoCell"
      });
    }
  } catch (cause) {
    throw toolError.invalidInput(
      `could not place the image at ${JSON.stringify(at)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Use a single cell like "F2" or a range like "A10:H30".',
      { cause }
    );
  }

  const size = isCell
    ? `${Math.round(image.width)}×${Math.round(image.height)} pt`
    : "sized to the range";
  // For a diagram the counts are the only verification the model can get: it
  // cannot open the workbook and look at the picture.
  const drawn = image.diagram === undefined ? "" : ` — ${summariseDiagram(image.diagram)}`;
  return `placed ${image.origin} at ${reference} (${size}, ${image.mediaType})${drawn}`;
}

/**
 * Report the pictures on a sheet.
 *
 * Every write tool in this server ends by telling the model to read the file back
 * and verify. For an image that instruction was unfollowable: `sheet_read` renders
 * cells, and a picture occupies no cell — so a model that had just placed a logo
 * had no way to confirm it, and the honest answer to "did it work" was "the tool
 * said so". Word documents already report their image count from `doc_read` and
 * `doc_inspect`; this closes the same loop for a workbook.
 *
 * The anchor is included rather than just the count, because the failure that
 * actually happens is a picture in the wrong place, not a missing one.
 */
export function describeSheetImages(ws: SheetHandle): string[] {
  const placed = Image.list(ws);
  if (placed.length === 0) {
    return [];
  }
  return [
    `- images: ${placed.length} (${placed.map(describeAnchor).join(", ")}) — not shown in the grid below; a picture occupies no cell`
  ];
}

/**
 * Render one anchor as the address range the caller would recognise.
 *
 * The stored bottom-right anchor is an **edge, not a cell**: with a zero offset the
 * picture stops at the left/top edge of `br`, so the last cell it actually covers
 * is one before it. Reporting the raw anchor turns a picture placed at `A6:H26`
 * into `A6:I27`, which reads as an off-by-one bug in the placement rather than in
 * the description — the worst kind of wrong report, because it sends the model to
 * fix something that is already correct.
 *
 * A non-zero offset means the picture genuinely does reach into that cell, so it is
 * named as-is.
 */
function describeAnchor(image: ReturnType<typeof Image.list>[number]): string {
  const range = image.range;
  const topLeft = range?.tl;
  if (topLeft === undefined) {
    // A background or header/footer picture is not anchored to the grid at all.
    return "not anchored to a cell";
  }
  const from = encodeAnchor(topLeft.nativeCol, topLeft.nativeRow);
  const bottomRight = range?.br;
  if (bottomRight !== undefined) {
    const lastColumn =
      bottomRight.nativeColOff > 0 ? bottomRight.nativeCol : bottomRight.nativeCol - 1;
    const lastRow =
      bottomRight.nativeRowOff > 0 ? bottomRight.nativeRow : bottomRight.nativeRow - 1;
    return `${from}:${encodeAnchor(Math.max(topLeft.nativeCol, lastColumn), Math.max(topLeft.nativeRow, lastRow))}`;
  }
  const ext = range?.ext;
  return ext === undefined
    ? from
    : `${from} at ${Math.round(ext.width ?? 0)}×${Math.round(ext.height ?? 0)} px`;
}

/** Encode a 0-based, possibly fractional anchor as an A1 address. */
function encodeAnchor(column: number, row: number): string {
  return Address.encodeCell({ r: Math.floor(row), c: Math.floor(column) });
}
