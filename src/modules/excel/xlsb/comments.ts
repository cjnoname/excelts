/**
 * Cell comments (classic notes): the `xl/comments{N}.bin` part, plus the `BrtLegacyDrawing` that points
 * the sheet at the VML holding the note boxes.
 *
 * **This is the one feature in this module verified against Excel's own bytes.** Two corpus workbooks
 * carry comments — `poi-comments.xlsb` and `poi-testVarious.xlsb`, fourteen comments between them — and
 * every layout below was read out of them and cross-checked against MS-XLSB rather than taken from the
 * specification alone. The part's shape:
 *
 * ```text
 * BrtBeginComments
 *   BrtBeginCommentAuthors
 *     BrtCommentAuthor*        XLWideString — one per distinct author
 *   BrtEndCommentAuthors
 *   BrtBeginCommentList
 *     BrtBeginComment          36 bytes: iauthor (i32), rfx (16), guid (16)
 *     BrtCommentText           RichStr
 *     BrtEndComment
 *   BrtEndCommentList
 * BrtEndComments
 * ```
 *
 * **A comment is three parts of the package, not one**, which is the thing that makes this larger than
 * the records suggest. The text lives in `comments{N}.bin`; the *box* — where it sits, how big it is,
 * whether it is visible — lives in `xl/drawings/vmlDrawing{N}.vml` as legacy VML; and the sheet needs a
 * `BrtLegacyDrawing` naming the relationship to that VML or Excel shows no comments at all. The corpus
 * confirms all three: `poi-comments.xlsb` has a `BrtLegacyDrawing` in its sheet, a `vmlDrawing1.vml` of
 * 3,395 bytes and a `comments1.bin`. Writing the records without the VML produces a file Excel opens
 * with the comment data present and nothing on screen.
 *
 * The VML is not written here. It is identical to the XLSX form — the same `vmlDrawing1.vml`, the same
 * schema — so `xlsb/write/package.ts` renders it through the existing `VmlDrawingXform` rather than this
 * module growing a second copy of a shape that has nothing to do with BIFF12.
 */
import type { RichText } from "@excel/types";
import { decodeCell, encodeCell } from "@excel/utils/address";
import {
  encodeBiffRecords,
  encodeRange,
  encodeWideString,
  readRange,
  readWideString,
  type BiffRange
} from "@excel/xlsb/binary";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** One comment, in the shape the XLSX comment writer also consumes. */
export interface SheetComment {
  /** The cell it is anchored to, as an `A1` reference. */
  readonly ref: string;
  readonly author: string;
  /** Rich runs. A comment with one unformatted run is the common case. */
  readonly texts: readonly RichText[];
  /**
   * The rest of the note: margins, protection, `editAs`.
   *
   * None of it reaches a BIFF12 record — the note *box* is VML, not binary — but it has to travel with
   * the comment because the VML renderer needs it, and it would otherwise be dropped between the model
   * and the part. Rendering without it throws rather than producing a box with defaults.
   */
  readonly note?: Record<string, unknown>;
}

/** Excel's placeholder when a comment carries no author. */
const DEFAULT_AUTHOR = "Author";

/**
 * Serialise a whole `xl/comments{N}.bin`.
 *
 * Authors are deduplicated and referenced by index, which is what the format wants and also what the
 * XLSX writer does — `poi-comments.xlsb` carries two authors for four comments, and its `iauthor` values
 * are 0 and 1.
 */
export function encodeCommentsPart(comments: readonly SheetComment[]): Uint8Array {
  const authors = [...new Set(comments.map(comment => comment.author || DEFAULT_AUTHOR))];
  const records: Emitted[] = [
    record("BrtBeginComments"),
    record("BrtBeginCommentAuthors"),
    ...authors.map(author => record("BrtCommentAuthor", encodeWideString(author))),
    record("BrtEndCommentAuthors"),
    record("BrtBeginCommentList")
  ];
  for (const comment of comments) {
    const index = authors.indexOf(comment.author || DEFAULT_AUTHOR);
    records.push(
      record("BrtBeginComment", encodeCommentHeader(index, comment.ref)),
      record("BrtCommentText", encodeRichString(comment.texts)),
      record("BrtEndComment")
    );
  }
  records.push(record("BrtEndCommentList"), record("BrtEndComments"));
  return encodeBiffRecords(records);
}

/** Read a whole `xl/comments{N}.bin`. */
export function readCommentsPart(
  bytes: Uint8Array,
  part: string,
  records: (bytes: Uint8Array, part: string) => Iterable<{ id: number; payload: Uint8Array }>,
  nameOf: (id: number) => string | undefined
): readonly SheetComment[] {
  const authors: string[] = [];
  const comments: SheetComment[] = [];
  let pending: { author: number; ref: string } | undefined;
  for (const record of records(bytes, part)) {
    const name = nameOf(record.id);
    if (name === "BrtCommentAuthor") {
      authors.push(
        safely(() => readWideString(new BinaryReader(record.payload, 0, part), part)) ?? ""
      );
      continue;
    }
    if (name === "BrtBeginComment") {
      pending = safely(() => readCommentHeader(record.payload, part));
      continue;
    }
    if (name === "BrtCommentText" && pending !== undefined) {
      const texts = safely(() => readRichString(record.payload, part)) ?? [];
      comments.push({
        ref: pending.ref,
        // A negative or out-of-range `iauthor` is a malformed record, not an author. Falling back to
        // Excel's own placeholder keeps the comment rather than dropping it over its byline.
        author: authors[pending.author] ?? DEFAULT_AUTHOR,
        texts
      });
      pending = undefined;
    }
  }
  return comments;
}

/** `BrtBeginComment`: author index, the anchor as an `rfx`, then a GUID. Thirty-six bytes. */
function encodeCommentHeader(author: number, ref: string): Uint8Array {
  const cell = decodeCell(ref);
  const range: BiffRange = {
    firstRow: cell.r,
    lastRow: cell.r,
    firstColumn: cell.c,
    lastColumn: cell.c
  };
  return concatUint8Arrays([
    new BinaryWriter().writeInt32(author).toUint8Array(),
    encodeRange(range),
    // The GUID is all zeros in every one of the fourteen corpus comments, both files Excel-authored
    // for the comment data. It identifies a *threaded* comment's conversation; a classic note has no
    // conversation, so there is nothing to identify and Excel writes zeros. Generating one here would
    // invent an identity the note does not have.
    new Uint8Array(16)
  ]);
}

function readCommentHeader(payload: Uint8Array, part: string): { author: number; ref: string } {
  const reader = new BinaryReader(payload, 0, part);
  const author = reader.readInt32();
  const range = readRange(reader);
  // The anchor is stored as a range but a note is attached to one cell, so the first corner is the
  // address. Both corners are equal in every corpus comment.
  return { author, ref: encodeCell({ r: range.firstRow, c: range.firstColumn }) };
}

/**
 * `RichStr` (MS-XLSB 2.5.122), which `BrtCommentText` must be — the specification requires
 * `fRichStr` to be 1 for this record.
 *
 * ```text
 * flags   1 byte   bit 0 fRichStr, bit 1 fExtStr
 * text    XLWideString
 * runs    u32 count, then count × (ich u16, ifnt u16)   — present when fRichStr
 * ```
 *
 * The arithmetic checks out against the corpus: a 69-byte `BrtCommentText` holding 26 characters is
 * `1 + 4 + 52 + 4 + 2×4`, and a 101-byte one holding 42 characters is `1 + 4 + 84 + 4 + 2×4`. Both have
 * two runs, which is Excel putting the author's name in bold ahead of the body.
 */
function encodeRichString(texts: readonly RichText[]): Uint8Array {
  // **A single run when the text has no segmentation of its own**, rather than none. `fRichStr` is set below,
  // which says formatting runs follow, and Excel writes exactly one — at character 0, pointing at font 0 —
  // for a plain comment. Writing a count of zero beside a set `fRichStr` is a record that announces runs and
  // then has none; it is what this produced, and it is four bytes shorter than every comment Excel writes.
  const runs = texts.length > 1 ? texts : texts.length === 1 ? [texts[0]!] : [];
  const text = texts.map(entry => entry.text).join("");
  const head = new BinaryWriter();
  // `fRichStr` is set unconditionally: the specification requires it for this record.
  head.writeUint8(0x01);
  const body = [head.toUint8Array(), encodeWideString(text)];

  const runTable = new BinaryWriter().writeUint32(runs.length);
  let offset = 0;
  for (const run of runs) {
    runTable.writeUint16(Math.min(offset, 0xffff));
    // `ifnt` indexes the styles part's font table. This writer does not resolve a comment run's font
    // into that table — doing so would mean interning fonts from a part that is written before the
    // styles are finalised — so every run points at font 0 and the *segmentation* survives while the
    // formatting does not. That is reported as a loss rather than passed off as fidelity.
    runTable.writeUint16(0);
    offset += [...run.text].length;
  }
  body.push(runTable.toUint8Array());
  return concatUint8Arrays(body);
}

/** Read a `RichStr` back to rich runs. */
function readRichString(payload: Uint8Array, part: string): readonly RichText[] {
  const reader = new BinaryReader(payload, 0, part);
  const flags = reader.readUint8();
  const text = readWideString(reader, part);
  if ((flags & 0x01) === 0) {
    return [{ text }];
  }
  // The run table splits the text; the fonts it names are not resolved, for the reason above. Splitting
  // on the offsets still recovers the structure a caller can see — where the author's byline ends and
  // the body begins — which is the part that carries meaning without the styles part.
  let count = 0;
  try {
    count = reader.readUint32();
  } catch {
    return [{ text }];
  }
  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    try {
      offsets.push(reader.readUint16());
      reader.readUint16(); // ifnt, unresolved.
    } catch {
      break;
    }
  }
  if (offsets.length < 2) {
    return [{ text }];
  }
  const characters = [...text];
  const runs: RichText[] = [];
  for (let index = 0; index < offsets.length; index++) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : characters.length;
    const slice = characters.slice(start, end).join("");
    if (slice !== "") {
      runs.push({ text: slice });
    }
  }
  return runs.length > 0 ? runs : [{ text }];
}

/** Run a decode step, treating a malformed payload as absent rather than fatal. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
