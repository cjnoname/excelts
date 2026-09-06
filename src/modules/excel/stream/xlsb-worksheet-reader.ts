/**
 * An XLSB worksheet as a stream of rows.
 *
 * **One reader surface, two decoders.** `Stream.WorkbookReader` hands out a `WorksheetReader` whose `parse()` yields
 * `{ eventType: "row", value: RowData }`; the XML path produces those from SAX events and this produces the same ones
 * from BIFF12 records. A caller writes one loop and cannot tell which container it is reading, which is the property
 * that makes this worth having rather than a second API.
 *
 * ## What streams and what does not
 *
 * A row is emitted as soon as the next row header arrives, so nothing accumulates: a million-row sheet is a million
 * events and one row of memory. What must exist *first* is the shared-string table and the style table, because a
 * cell record holds an index into each rather than a value — `BrtCellIsst` is a number. The workbook reader already
 * handles that for XLSX by spooling a sheet that arrives before `sharedStrings`, and the same mechanism covers this.
 *
 * ## What a streamed read does not surface
 *
 * Measured against the buffered reader on this library's own examples, not assumed — `conditional-formatting` streams
 * 35 of 35 cells identically, and the three omissions below are exactly where the two disagree:
 *
 * - **Formulas arrive as their cached value.** `BrtFmlaNum` carries both the result and the token stream, and decoding
 *   the tokens needs the workbook's sheet names, defined names and table indices. A streamed read yields the number
 *   Excel last computed, which is what a bulk read wants; a caller who needs the expression reads the workbook.
 * - **Rich text arrives flattened.** A styled string's runs live in the shared-string table beside the text, and a
 *   cell that points at one gets the text without the runs.
 * - **Everything after `BrtEndSheetData`** — merges, conditional formats, data validations, panes, page setup,
 *   hyperlinks, comments. A forward reader has emitted its rows before those records arrive, so they cannot be
 *   attached to cells a caller has already seen. The XML streaming reader has the same limitation for the same
 *   reason. A merged region's continuation cells therefore stream as empty rather than repeating the anchor's value.
 *
 * None of these is reported as a loss, because nothing is lost from the *file*: they are absent from the events, and
 * the buffered reader is where a caller goes for them.
 */
import type { RowData } from "@excel/core/row";
import { rowCreate } from "@excel/core/row";
import type { WorksheetData } from "@excel/core/worksheet";
import { rowSetModel } from "@excel/core/worksheet-core";
import { streamBiffRecords } from "@excel/stream/xlsb-record-stream";
import { encodeCol } from "@excel/utils/address";
import { errorTextOf } from "@excel/xlsb/error-values";
import { BinaryReader } from "@utils/binary";

/** The sheet's last column, zero-based. `encodeCol` refuses anything past it, and so does this reader. */
const MAX_COLUMN_INDEX = 16_383;

/** What a streamed row needs from the workbook to resolve its cells. */
export interface XlsbRowContext {
  /** The shared-string table, indexed by `BrtCellIsst`. */
  readonly sharedStrings: readonly string[];
  /** Number formats by style index, so a serial wearing a date format becomes a `Date`. */
  readonly numberFormats?: readonly (string | undefined)[];
  /** `date1904`, which shifts every serial by four years and a day. */
  readonly date1904?: boolean;
  /** The sheet a row belongs to; the core row factory stores it as a back-pointer. */
  readonly worksheet: WorksheetData;
}

/** A cell as the row assembler holds it, before the row is built. */
interface StreamedCell {
  readonly column: number;
  readonly value: string | number | boolean | Date | null;
  readonly formula?: string;
  readonly styleIndex: number;
}

/**
 * Rows from a chunked XLSB worksheet part.
 *
 * The record names rather than the ids are switched on, because an id is a number in a table and a name is what the
 * specification calls the thing — a reader that switched on `0x00` would be unreadable and a renumbered constant
 * would break it silently.
 */
export async function* streamXlsbRows(
  chunks: AsyncIterable<Uint8Array>,
  part: string,
  context: XlsbRowContext
): AsyncIterableIterator<RowData> {
  let currentRow: number | undefined;
  let cells: StreamedCell[] = [];
  let inSheetData = false;

  /** Hand over the row being assembled, if there is one. */
  const flush = (): RowData | undefined => {
    if (currentRow === undefined) {
      return undefined;
    }
    const row = buildRow(currentRow, cells, context);
    currentRow = undefined;
    cells = [];
    return row;
  };

  for await (const record of streamBiffRecords(chunks, part)) {
    switch (record.name) {
      case "BrtBeginSheetData":
        inSheetData = true;
        continue;
      case "BrtEndSheetData": {
        // Everything after this is sheet-level: merges, conditional formats, page setup. A forward reader has already
        // emitted its rows, so there is nothing left to attach them to — see the note at the top of this file.
        const last = flush();
        if (last !== undefined) {
          yield last;
        }
        inSheetData = false;
        continue;
      }
      default:
        break;
    }
    if (!inSheetData) {
      continue;
    }
    if (record.name === "BrtRowHdr") {
      const previous = flush();
      if (previous !== undefined) {
        yield previous;
      }
      currentRow = new BinaryReader(record.payload, 0, part).readUint32();
      continue;
    }
    const cell = decodeCell(record, context, part);
    if (cell !== undefined) {
      cells.push(cell);
    }
  }
  const trailing = flush();
  if (trailing !== undefined) {
    yield trailing;
  }
}

/**
 * One cell record, or `undefined` when the record is not a cell.
 *
 * Only the record kinds a bulk read is about are decoded. A record this does not know is skipped rather than guessed
 * at: a streamed read that invented a value would be worse than one that omitted it, and the buffered reader is where
 * a caller goes for completeness.
 */
function decodeCell(
  record: { readonly name: string | undefined; readonly payload: Uint8Array },
  context: XlsbRowContext,
  part: string
): StreamedCell | undefined {
  const name = record.name;
  if (name === undefined || (!name.startsWith("BrtCell") && !name.startsWith("BrtFmla"))) {
    return undefined;
  }
  // **The `BrtShort*` variants are deliberately absent from this switch.**
  //
  // They used to share each branch with their long counterparts, which meant reading a `column`, a four-byte
  // `iStyleRef` and then the value — the *long* layout. `spec/records.ts` declares no fields for them precisely
  // because that layout "has not been established here, and guessing an offset is how a reader and a writer come to
  // agree with each other and disagree with Excel", and the buffered reader skips and counts them for the same reason.
  // So the two readers disagreed about the same records, with the streaming one guessing.
  //
  // What the guess costs if the short form is in fact shorter: a `BrtShortReal` carrying `column` and a `double` is
  // twelve bytes, this reads sixteen, and `BinaryReader` throws — which in a streaming read takes down the whole sheet
  // rather than one cell. A longer payload would be read at the wrong offsets instead, and silently.
  //
  // Measured cost of not decoding them: the seven ids appear **zero** times across the twenty-three pinned corpus
  // workbooks, eighteen of them Excel-authored.
  const reader = new BinaryReader(record.payload, 0, part);
  const column = reader.readUint32();
  // **A column past the sheet's last is refused here rather than at the point the address is built.**
  //
  // The address used to come from a private base-26 loop with no upper bound, so a corrupt record carrying column
  // 100,000 produced `EQXE1` — an address no reader accepts — silently. Sharing `encodeCol` brings the bound, but
  // `encodeCol` *throws*, and a throw from inside a streamed read takes down the whole sheet for one bad cell. This
  // reader already has the right answer for a record it cannot use: skip it, which is what every unhandled record kind
  // does.
  if (column > MAX_COLUMN_INDEX) {
    return undefined;
  }
  // `iStyleRef` is 24 bits followed by a flags byte — read as a `u32` and masked, which is what the buffered reader
  // does and the only reading that survives a non-zero flags byte.
  const styleIndex = reader.readUint32() & 0x00ffffff;
  const numberFormat = context.numberFormats?.[styleIndex];
  switch (name) {
    case "BrtCellBlank":
      return { column, value: null, styleIndex };
    case "BrtCellRk":
      return {
        column,
        value: dated(decodeRk(reader.readUint32()), numberFormat, context),
        styleIndex
      };
    case "BrtCellReal":
      return { column, value: dated(reader.readFloat64(), numberFormat, context), styleIndex };
    case "BrtCellBool":
      return { column, value: reader.readUint8() !== 0, styleIndex };
    case "BrtCellIsst":
      return { column, value: context.sharedStrings[reader.readUint32()] ?? "", styleIndex };
    case "BrtCellSt":
      return { column, value: readWideString(reader), styleIndex };
    // **An error cell is a value, and it was being dropped.** A streamed read of a workbook holding `#N/A` omitted the
    // cell entirely, so a caller could not tell it from an empty one — while the buffered reader has decoded these
    // since `error-values.ts` existed. Same table, same eight codes; an unrecognised byte still yields nothing rather
    // than an invented error.
    case "BrtCellError":
    case "BrtFmlaError": {
      const text = errorTextOf(reader.readUint8());
      return text === undefined ? undefined : { column, value: text, styleIndex };
    }
    case "BrtFmlaNum":
      return { column, value: dated(reader.readFloat64(), numberFormat, context), styleIndex };
    case "BrtFmlaBool":
      return { column, value: reader.readUint8() !== 0, styleIndex };
    case "BrtFmlaString":
      return { column, value: readWideString(reader), styleIndex };
    default:
      // A rich string, a shared-formula follower, or one of the `BrtShort*` variants above. Skipped rather than
      // approximated — the buffered reader is where a caller goes for completeness.
      return undefined;
  }
}

/**
 * `RkNumber` — a float packed into four bytes.
 *
 * Two flags: bit 0 says the value was divided by a hundred, bit 1 says the remaining thirty bits are an integer
 * rather than the top of a double. Excel writes this form wherever it fits, which is most numeric cells.
 */
function decodeRk(raw: number): number {
  const hundredth = (raw & 0x01) !== 0;
  const integer = (raw & 0x02) !== 0;
  let value: number;
  if (integer) {
    // Sign-extended from 30 bits.
    const bits = raw >> 2;
    value = bits & 0x20000000 ? bits - 0x40000000 : bits;
  } else {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(4, raw & 0xfffffffc, true);
    value = new DataView(buffer).getFloat64(0, true);
  }
  return hundredth ? value / 100 : value;
}

/** An `XLWideString`: a UTF-16LE run with a 32-bit character count. */
function readWideString(reader: BinaryReader): string {
  const count = reader.readUint32();
  let text = "";
  for (let index = 0; index < count; index++) {
    text += String.fromCharCode(reader.readUint16());
  }
  return text;
}

/** A serial wearing a date format is a date — the same rule the buffered reader applies. */
function dated(
  value: number,
  numberFormat: string | undefined,
  context: XlsbRowContext
): number | Date {
  if (numberFormat === undefined || !looksLikeDate(numberFormat)) {
    return value;
  }
  const epoch = context.date1904 === true ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + value * 86_400_000);
}

/**
 * Whether a number format renders a date.
 *
 * A deliberately narrow test on the format's *codes* rather than a list of format ids: `yy`, `mm`, `dd`, `hh` and `ss`
 * are what make a serial a date, and a currency format containing the letter `d` must not qualify. Escaped text and
 * colour sections are stripped first for that reason.
 */
function looksLikeDate(format: string): boolean {
  const stripped = format
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return (
    /(\byy|y{2,}|m{1,5}|d{1,4}|h{1,2}|s{1,2}|AM\/PM)/i.test(stripped) && /[ymdhs]/i.test(stripped)
  );
}

/** The assembled row, through the core factory so it is the same shape the XML path yields. */
function buildRow(
  number: number,
  cells: readonly StreamedCell[],
  context: XlsbRowContext
): RowData {
  const row = rowCreate(context.worksheet, number + 1);
  if (cells.length === 0) {
    return row;
  }
  // Through `rowSetModel`, which is the same door the buffered reader and the XML streaming reader use. Building the
  // cells by hand would be a third construction of a row and would drift from those two — and a row that differs by
  // container is the defect this module has produced most often.
  rowSetModel(row, {
    number: number + 1,
    min: cells[0]!.column + 1,
    max: cells[cells.length - 1]!.column + 1,
    cells: cells.map(cell => ({
      address: `${encodeCol(cell.column)}${number + 1}`,
      type: typeOf(cell.value),
      ...(cell.value === null ? {} : { value: cell.value }),
      ...(cell.styleIndex === 0 ? {} : { styleId: cell.styleIndex })
    }))
  } as never);
  return row;
}

/** The model's value-type tag for a streamed value. */
function typeOf(value: string | number | boolean | Date | null): number {
  if (value === null) {
    return 0;
  }
  switch (typeof value) {
    case "number":
      return 2;
    case "string":
      return 3;
    case "boolean":
      return 5;
    default:
      return value instanceof Date ? 4 : 0;
  }
}
