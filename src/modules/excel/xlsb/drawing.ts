/**
 * Images in a binary workbook.
 *
 * **The format does not make this hard; the previous absence of it was a gap in this library rather
 * than in BIFF12.** A picture in a `.xlsb` is stored exactly as it is in a `.xlsx`: the bytes live in
 * `xl/media/`, the placement lives in `xl/drawings/drawingN.xml`, and the worksheet points at the
 * drawing through its own `.rels`. Only one thing is binary — a `BrtDrawing` record in the sheet's
 * record stream — and it carries nothing but the relationship id.
 *
 * So the drawing XML, the media parts and the anchor arithmetic are all shared with the XLSX path
 * rather than reimplemented. That is the whole point: two serialisers for the same XML would be two
 * things to keep in step, and the one that got less use would be the one that drifted.
 *
 * ## `BrtDrawing`, established from Excel's output
 *
 * Twelve bytes in `picture.xlsb`, in both of its sheets: `04 00 00 00 72 00 49 00 64 00 32 00` — an
 * `XLWideString` of four characters reading `"rId2"`. And `xl/worksheets/_rels/sheet1.bin.rels`
 * declares exactly that id, pointing at `../drawings/drawing1.xml`. The record is a relationship id
 * and nothing else, which the length confirms: `4 + 2 × 4 = 12`.
 *
 * Its position is equally settled — after `BrtMargins`, before the sheet's closing scope:
 *
 * ```text
 * … BrtSheetProtection → BrtPrintOptions → BrtMargins → BrtDrawing → … → BrtEndSheet
 * ```
 */
import { encodeWideString, readWideString } from "@excel/xlsb/binary";
import { BinaryReader } from "@utils/binary";

/**
 * `BrtDrawing` — the relationship id of the sheet's drawing part.
 *
 * A sheet has at most one, which is why this is a single id rather than a collection: every picture,
 * chart and shape on a sheet is an anchor inside that one drawing.
 */
export function encodeDrawing(relationshipId: string): Uint8Array {
  return encodeWideString(relationshipId);
}

/** Read a `BrtDrawing`, or `undefined` when the record is malformed. */
export function readDrawing(payload: Uint8Array, part: string): string | undefined {
  try {
    const id = readWideString(new BinaryReader(payload, 0, part), part);
    return id.length === 0 ? undefined : id;
  } catch {
    // A truncated record costs the drawing reference, not the sheet.
    return undefined;
  }
}
