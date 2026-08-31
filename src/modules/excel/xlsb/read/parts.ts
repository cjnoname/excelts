/**
 * Read BIFF12 parts into a workbook model.
 *
 * Every field comes from `spec/decode.ts`, so this cannot disagree with the writer, the
 * disassembler or the validator about where a value lives — they all read the one table.
 *
 * ## What it refuses to do
 *
 * A record whose layout the table does not describe is skipped and counted, not guessed
 * at. The seven `BrtShort*` cell variants are in that position, and they are common in
 * Excel-authored files, so this reader is honest about being able to round-trip what
 * *this* library writes without yet being able to read everything Excel writes. That is
 * a real limitation and it is reported (`unreadRecords`) rather than hidden — a reader
 * that silently drops cells is worse than one that says it cannot read them.
 */

import type { HeaderFooter, Margins } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  COLUMN_WIDTH_UNITS,
  TWIPS_PER_POINT,
  NAME_FLAG_FUNCTION,
  NAME_FLAG_HIDDEN,
  WORKBOOK_FLAG_1904,
  iterateBiffRecords,
  readCell,
  readWideString,
  sheetStateName,
  type BiffRecord
} from "@excel/xlsb/binary";
import { readDrawing } from "@excel/xlsb/drawing";
import { decodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { readHeaderFooter } from "@excel/xlsb/header-footer";
import {
  readMargins,
  readPageSetup,
  readSheetFormatInfo,
  type ReadPageSetup,
  type SheetFormatInfo
} from "@excel/xlsb/page-setup";
import { readSheetProperties, type SheetProperties } from "@excel/xlsb/sheet-properties";
import {
  cellField,
  decodeRecord,
  numberField,
  rangeField,
  type DecodedRecord
} from "@excel/xlsb/spec/decode";
import { INFERRED_VALUES, recordSpec } from "@excel/xlsb/spec/records";
import type { StyleTable } from "@excel/xlsb/styles";
import { NodeType } from "@formula/syntax/ast";
import { printAst } from "@formula/syntax/print";
import { BinaryReader } from "@utils/binary";

/** A cell as read from a worksheet part. */
export interface ReadCell {
  readonly row: number;
  readonly column: number;
  readonly value: string | number | boolean | null;
  /**
   * Index into the styles part's cell formats.
   *
   * The style itself is *not* copied here. It used to be — five fields resolved and attached to every
   * cell — which meant a sheet of fifty thousand cells sharing one format carried fifty thousand
   * copies of the same five references, for a table the caller already holds. The index is the
   * information; resolving it is the applying step's job.
   */
  readonly styleIndex: number;
  /**
   * Number format for this cell, resolved through the styles part.
   *
   * The one style field that stays, because it is not only a style: it is the difference between a
   * date and the number `42663`, and this reader needs it to decide which of the two a value *is*
   * before anything is applied.
   */
  readonly numberFormat?: string;
  /** Formula text, when the cell carries one. `value` is then the cached result. */
  readonly formula?: string;
  /** Cell whose formula this one shares, for a `PtgExp` deferral. */
  readonly sharedFormulaOrigin?: { readonly row: number; readonly column: number };
}

/** A column width, in the units the public API uses. */
export interface ReadColumn {
  /** One-based, inclusive, matching `Column.min`/`max`. */
  readonly min: number;
  readonly max: number;
  readonly widthCharacters: number;
  /** Cell-format index the column declares for itself, when it declares one. */
  readonly styleIndex?: number;
}

export interface ReadWorksheet {
  readonly cells: readonly ReadCell[];
  /** Merged ranges, as `"A1:B2"` — the shape the public merge API takes. */
  readonly merges: readonly string[];
  /** Column widths, for the columns that declared one. */
  readonly columns: readonly ReadColumn[];
  /** Row heights in points, keyed by one-based row number. */
  readonly rowHeights: ReadonlyMap<number, number>;
  /** Records skipped because their layout is not described. Keyed by record name. */
  /**
   * Cell-format index each row declares for itself, by one-based row number.
   *
   * Only non-zero entries: `BrtRowHdr` carries a zero for a row with no format of its own, and
   * recording those would give every row a style it does not have.
   */
  readonly rowStyles: ReadonlyMap<number, number>;
  /** What the sheet prints at the top and bottom of each page, when it declares any. */
  readonly headerFooter?: Partial<HeaderFooter>;
  /** Tab colour and VBA code name, when the sheet declares either. */
  readonly sheetProperties?: SheetProperties;
  /** Page margins, when the sheet declares them. */
  readonly margins?: Margins;
  /** Paper, scaling and orientation, when the sheet declares any of them. */
  readonly pageSetup?: ReadPageSetup;
  /** Default row height and column width, when the sheet declares them. */
  readonly formatInfo?: SheetFormatInfo;
  readonly unreadRecords: ReadonlyMap<string, number>;
  /**
   * Record ids with no name in the spec table, counted by id.
   *
   * Distinct from `unreadRecords`, which counts records this library *recognises* and cannot
   * decode. These it does not recognise at all, so there is no name to report — only the id, in
   * hex, which is what a future spec-table entry would be keyed by.
   */
  readonly unknownRecords: ReadonlyMap<number, number>;
  /**
   * Formulas that could not be decoded, by address.
   *
   * Separate from `unreadRecords` because the cell itself *was* read — its cached result is
   * present and usable — and only the expression was lost. Reporting them together would
   * make a workbook that reads fine look like one with missing cells.
   */
  readonly undecodedFormulas: readonly string[];
  /**
   * Cells whose value was an error code, by address.
   *
   * The cell is kept as a blank — its position and format are real information — but the error is
   * lost, and this is the only way a caller learns that. It used to be reported nowhere at all:
   * `BrtCellError` decoded to `null`, which is indistinguishable from `BrtCellBlank`, so a workbook
   * full of `#N/A` read back as a workbook full of empty cells and said nothing.
   *
   * Not `unreadRecords`, because the record *was* read and understood. What is missing is a mapping
   * from the error code byte to an error value, and no workbook in the reference corpus contains a
   * single `BrtCellError` or `BrtFmlaError` — so the byte's meaning is unobserved, and inventing it
   * is how a reader comes to agree with this library's own writer and disagree with Excel.
   */
  readonly errorCells: readonly string[];
  /**
   * Relationship id from the sheet's `BrtDrawing`, when it has one.
   *
   * This reader does not model drawings — the XML and the media survive as opaque parts — but the
   * *reference* is binary, so it is the one piece a rewrite has to reproduce itself. Dropping it left a
   * package whose drawing part and `.rels` were both intact and whose sheet no longer pointed at
   * either: every picture in a read-modify-written workbook silently disappeared from Excel while every
   * structural check still passed.
   */
  readonly drawingRelationshipId?: string;
}

/**
 * Read `xl/sharedStrings.bin` into the string table a worksheet indexes into.
 *
 * @returns The texts, and how many of them arrived with formatting runs this reader dropped. The count
 *          is the point of the second field: the comment below has always described the loss, and
 *          describing it in a comment is not the same as telling the caller — a workbook of styled text
 *          read back as plain text and reported nothing.
 */
export function readSharedStrings(
  bytes: Uint8Array,
  part: string
): { readonly texts: string[]; readonly richCount: number } {
  const texts: string[] = [];
  let richCount = 0;
  for (const record of iterateBiffRecords(bytes, part)) {
    if (recordSpec(record.id)?.name !== "BrtSSTItem") {
      continue;
    }
    const decoded = decodeRecord(record, part);
    const text = decoded?.fields.get("text");
    // A rich string's formatting runs follow the text and are reported as a remainder
    // by the decoder; the text itself is complete, so the string is read and the runs
    // are what is lost. That is the right trade here — dropping the whole string
    // because it was bold would be worse.
    if (decoded !== undefined && decoded.trailingBytes > 0) {
      richCount++;
    }
    texts.push(typeof text === "string" ? text : "");
  }
  return { texts, richCount };
}

export interface ReadSheet {
  readonly name: string;
  readonly state: "visible" | "hidden" | "veryHidden";
  /** Relationship id naming the part that holds this sheet's records, when the file gives one. */
  readonly relId?: string;
}

export interface ReadWorkbook {
  /** Sheets, in workbook declaration order. */
  readonly sheets: readonly ReadSheet[];
  /**
   * Whether the workbook uses the 1904 date system.
   *
   * Every date serial in the workbook is relative to this epoch, so it has to be read from the
   * workbook part before any worksheet is interpreted.
   */
  readonly date1904: boolean;
  /** Sheet names alone, which is what a formula context needs. */
  readonly sheetNames: readonly string[];
  /**
   * Defined names, in declaration order.
   *
   * `PtgName` is a one-based index into this list, so the order is load-bearing: reading
   * the names into a map keyed by name would make every `PtgName` unresolvable.
   */
  readonly definedNames: readonly string[];
  /**
   * The `BrtExternSheet` table a 3D reference's `ixti` indexes.
   *
   * Needed before any worksheet is read, because every `PtgRef3d` in every formula resolves
   * through it. See `PtgContext.externSheets` for why treating `ixti` as a sheet index is wrong.
   */
  readonly externSheets: readonly { readonly first: number; readonly last: number }[];
  /**
   * Names a caller would recognise, with the range each points at.
   *
   * Separate from `definedNames`, which is the raw table in declaration order because `PtgName`
   * is a one-based index into it and must include the hidden entries. This list drops those: a
   * workbook carrying `_xlfn.CONCAT` — a stub Excel writes so an older consumer degrades
   * gracefully — has a defined name no user ever created, and reporting it as one would be
   * wrong. The two lists therefore differ in both length and purpose.
   */
  readonly namedRanges: readonly { readonly name: string; readonly ranges: readonly string[] }[];
  /**
   * Names whose definition is an expression rather than a reference, as `name: expression`.
   *
   * Kept apart from `namedRanges` because they cannot go through `definedNamesAdd`, which takes an A1
   * reference. Reported rather than dropped: a workbook whose `Sales` is `OFFSET(…)` comes back without
   * it, and a formula built on that name then resolves to nothing.
   */
  readonly namedExpressions: readonly { readonly name: string; readonly expression: string }[];
}

/** Read `xl/workbook.bin`. */
export function readWorkbookPart(bytes: Uint8Array, part: string): ReadWorkbook {
  const sheets: ReadSheet[] = [];
  const definedNames: string[] = [];
  const namedRanges: { name: string; ranges: string[] }[] = [];
  const namedExpressions: { name: string; expression: string }[] = [];
  const externSheets: { first: number; last: number }[] = [];
  let date1904 = false;

  for (const record of iterateBiffRecords(bytes, part)) {
    const recordName = recordSpec(record.id)?.name;
    switch (recordName) {
      case "BrtWbProp": {
        const flags = numberField(decodeRecord(record, part), "flags") ?? 0;
        date1904 = (flags & WORKBOOK_FLAG_1904) !== 0;
        continue;
      }
      case "BrtExternSheet": {
        externSheets.push(...readExternSheets(record.payload, part));
        continue;
      }
      case "BrtBundleSh": {
        const decoded = decodeRecord(record, part);
        const name = decoded?.fields.get("name");
        if (typeof name === "string") {
          const relId = decoded?.fields.get("relId");
          sheets.push({
            name,
            state: sheetStateName(numberField(decoded, "state") ?? 0),
            // Carried so the caller can resolve the part through the relationships rather than
            // guessing it from the sheet's position, which a chartsheet makes wrong.
            ...(typeof relId === "string" ? { relId } : {})
          });
        }
        continue;
      }
      case "BrtName": {
        // Every name enters `definedNames`, hidden ones included, because `PtgName` is a
        // one-based index into the record order and skipping an entry shifts every later index.
        const parsed = readName(record.payload, part, {
          sheetNames: sheets.map(sheet => sheet.name),
          externSheets
        });
        if (parsed === undefined) {
          continue;
        }
        definedNames.push(parsed.name);
        if (!parsed.hidden && parsed.range !== undefined) {
          namedRanges.push({ name: parsed.name, ranges: [parsed.range] });
        }
        if (!parsed.hidden && parsed.expression !== undefined) {
          namedExpressions.push({ name: parsed.name, expression: parsed.expression });
        }
        continue;
      }
      default:
        continue;
    }
  }

  return {
    sheets,
    sheetNames: sheets.map(sheet => sheet.name),
    definedNames,
    namedRanges,
    namedExpressions,
    externSheets,
    date1904
  };
}

/** `BrtExternSheet`: a count, then that many `{ iSupBook, itabFirst, itabLast }` triples. */
function readExternSheets(payload: Uint8Array, part: string): { first: number; last: number }[] {
  const reader = new BinaryReader(payload, 0, part);
  const entries: { first: number; last: number }[] = [];
  try {
    const count = reader.readUint32();
    for (let index = 0; index < count; index++) {
      reader.readUint32(); // iSupBook — only the self-reference (0) is meaningful here
      entries.push({ first: reader.readUint32(), last: reader.readUint32() });
    }
  } catch {
    // A truncated table costs the 3D references, not the workbook.
  }
  return entries;
}

/**
 * `BrtName`, including the token stream that says what the name points at.
 *
 * `fProc` selects a longer tail — four extra nullable strings — but nothing after the token
 * stream is read, so the tail only matters for the record's length and is not walked.
 */
function readName(
  payload: Uint8Array,
  part: string,
  context: PtgContext
):
  | {
      name: string;
      /** The definition, when it is a reference `DefinedNames` can take. */
      range: string | undefined;
      /** The definition, when it is an expression rather than a reference. */
      expression: string | undefined;
      hidden: boolean;
    }
  | undefined {
  const reader = new BinaryReader(payload, 0, part);
  try {
    const flags = reader.readUint32();
    reader.skip(1); // keyboard shortcut
    reader.readUint32(); // sheet index: 0xFFFFFFFF for a workbook-scoped name
    const name = readWideString(reader, part);
    const tokens = reader.readBytes(reader.readUint32());
    // A hidden or function-stub name is machinery, not something a user named.
    const hidden = (flags & (NAME_FLAG_HIDDEN | NAME_FLAG_FUNCTION)) !== 0;
    let range: string | undefined;
    let expression: string | undefined;
    if (!hidden && tokens.length > 0) {
      try {
        const ast = decodePtg(tokens, context, `${part} name ${name}`);
        // A shared-formula reference cannot appear in a name, but the decoder's return type
        // admits one, so it is discriminated the same way the cell path does it.
        if (!("sharedRow" in ast)) {
          const printed = printAst(ast);
          // **Asked of the AST, not of the string.** A name's definition is an expression, and only some
          // expressions are references: `=TRUE` and `=OFFSET(#REF!,0,0,COUNTA(#REF!),1)` are ordinary
          // defined names. `definedNamesAdd` takes an A1 reference and *throws* on anything else, so the
          // caller needs to know which it has before offering it — and the node type says so for free.
          //
          // Printing it and then re-parsing to find out would be a second grammar to keep in step with
          // `colCache`, and catching the throw instead costs an exception per name: the
          // `many-defined-names` fixture holds 35,422 of them, most of them `OFFSET(…)`, and 35,422
          // stack captures is the difference between a read and a hang.
          if (isReferenceNode(ast)) {
            range = printed;
          } else {
            expression = printed;
          }
        }
      } catch {
        // A definition this library cannot express is reported as a name with no range rather
        // than as no name: the name still exists, and `PtgName` still has to index it.
        range = undefined;
      }
    }
    return { name, range, expression, hidden };
  } catch {
    return undefined;
  }
}

/**
 * Whether a decoded definition is a *reference* rather than some other expression.
 *
 * The reference node types, and nothing else. A union of areas counts — `definedNamesAdd` takes each of
 * its members — while a whole-row or whole-column reference does not, because `colCache` wants a bounded
 * one. Everything else is an expression: a literal, an operator, a function call.
 */
function isReferenceNode(node: { readonly type: NodeType }): boolean {
  return (
    node.type === NodeType.CellRef ||
    node.type === NodeType.RangeRef ||
    node.type === NodeType.UnionRef
  );
}

/** Read one `xl/worksheets/sheetN.bin`. */
export function readWorksheetPart(
  bytes: Uint8Array,
  part: string,
  sharedStrings: readonly string[],
  formulaContext: PtgContext = {},
  styles?: StyleTable
): ReadWorksheet {
  const cells: ReadCell[] = [];
  const merges: string[] = [];
  const columns: ReadColumn[] = [];
  const rowHeights = new Map<number, number>();
  const unreadRecords = new Map<string, number>();
  const unknownRecords = new Map<number, number>();
  const rowStyles = new Map<number, number>();
  let headerFooter: Partial<HeaderFooter> | undefined;
  let sheetProperties: SheetProperties | undefined;
  let margins: Margins | undefined;
  let pageSetup: ReadPageSetup | undefined;
  let formatInfo: SheetFormatInfo | undefined;
  const undecodedFormulas: string[] = [];
  const errorCells: string[] = [];
  let drawingRelationshipId: string | undefined;
  let currentRow: number | undefined;

  for (const record of iterateBiffRecords(bytes, part)) {
    const spec = recordSpec(record.id);
    if (!spec) {
      // A record id this library has no name for. Counted rather than skipped in silence: the
      // reference corpus contains 26 such ids across 187 occurrences, and "this file holds
      // something I do not understand" is exactly the fact a caller cannot otherwise learn.
      // Framing is unaffected — the record's length prefix is honoured either way.
      unknownRecords.set(record.id, (unknownRecords.get(record.id) ?? 0) + 1);
      continue;
    }

    if (spec.name === "BrtMergeCell") {
      const range = rangeField(decodeRecord(record, part), "ref");
      if (range) {
        merges.push(
          `${encodeCol(range.firstColumn)}${range.firstRow + 1}:` +
            `${encodeCol(range.lastColumn)}${range.lastRow + 1}`
        );
      }
      continue;
    }
    if (spec.name === "BrtWsProp") {
      sheetProperties = readSheetProperties(record.payload, part);
      continue;
    }

    if (spec.name === "BrtBeginHeaderFooter") {
      headerFooter = readHeaderFooter(record.payload, part);
      continue;
    }

    if (spec.name === "BrtMargins") {
      margins = readMargins(record.payload, part);
      continue;
    }

    if (spec.name === "BrtDrawing") {
      drawingRelationshipId = readDrawing(record.payload, part);
      continue;
    }

    if (spec.name === "BrtPageSetup") {
      pageSetup = readPageSetup(record.payload, part);
      continue;
    }

    if (spec.name === "BrtWsFmtInfo") {
      formatInfo = readSheetFormatInfo(record.payload, part);
      continue;
    }

    if (spec.name === "BrtColInfo") {
      const decoded = decodeRecord(record, part);
      const first = numberField(decoded, "colFirst");
      const last = numberField(decoded, "colLast");
      const width = numberField(decoded, "width");
      if (first !== undefined && last !== undefined && width !== undefined) {
        const ixfe = numberField(decoded, "ixfe") ?? 0;
        columns.push({
          min: first + 1,
          max: last + 1,
          widthCharacters: width / COLUMN_WIDTH_UNITS,
          ...(ixfe === 0 ? {} : { styleIndex: ixfe })
        });
      }
      continue;
    }
    if (spec.category === "row") {
      const decoded = decodeRecord(record, part);
      currentRow = numberField(decoded, "rw");
      const height = numberField(decoded, "miyRw");
      const flags = numberField(decoded, "flags") ?? 0;
      // Only a height the author set is recorded. Excel writes the default into every row
      // header, so keeping them all would turn an unstyled sheet into one with a height on
      // every row — the `fUnsynced` flag is what distinguishes the two.
      if (
        currentRow !== undefined &&
        height !== undefined &&
        (flags & INFERRED_VALUES.rowHeightUnsynced) !== 0
      ) {
        rowHeights.set(currentRow + 1, height / TWIPS_PER_POINT);
      }
      const rowStyle = numberField(decoded, "ixfe") ?? 0;
      if (currentRow !== undefined && rowStyle !== 0) {
        rowStyles.set(currentRow + 1, rowStyle);
      }
      continue;
    }
    if (spec.category !== "cell") {
      continue;
    }
    // One path for every reason a cell cannot be read: no declared layout, a value shape
    // not yet mapped, or an index that does not resolve. An earlier version special-cased
    // the first with its own branch, which was redundant — a record with no layout decodes
    // to nothing and falls through here anyway — and redundant branches are how two paths
    // come to disagree.
    // Decoded **once**. This used to call `decodeRecord` here and again inside `readCellValue`, so
    // every cell in the sheet was parsed against its layout twice — on the hottest path in the reader,
    // for a result that cannot differ between the two calls.
    const decodedCell = decodeRecord(record, part);
    const value = readCellValue(decodedCell, spec.name, sharedStrings);
    if (value === undefined) {
      unreadRecords.set(spec.name, (unreadRecords.get(spec.name) ?? 0) + 1);
      continue;
    }
    const cell = cellField(decodedCell, "cell");
    if (cell === undefined || currentRow === undefined) {
      continue;
    }
    // An error cell reads as a blank, which is the honest outcome and not a silent one: the address
    // is recorded so the caller can be told the difference between "empty" and "was an error".
    if (spec.name === "BrtCellError" || spec.name === "BrtFmlaError") {
      errorCells.push(`${encodeCol(cell.column)}${currentRow + 1}`);
    }

    // A formula cell's expression sits after its cached value. The value is already read,
    // so a formula that cannot be decoded costs the expression and nothing else.
    let formula: string | undefined;
    let sharedFormulaOrigin: { row: number; column: number } | undefined;
    if (spec.name.startsWith("BrtFmla")) {
      const decoded = readFormula(record, part, spec.name, currentRow, cell.column, formulaContext);
      if (decoded === undefined) {
        undecodedFormulas.push(`${encodeCol(cell.column)}${currentRow + 1}`);
      } else if (typeof decoded === "string") {
        formula = decoded;
      } else {
        sharedFormulaOrigin = decoded;
      }
    }

    const numberFormat = styles?.numberFormats[cell.styleIndex];
    cells.push({
      row: currentRow,
      column: cell.column,
      value,
      styleIndex: cell.styleIndex,
      ...(numberFormat === undefined ? {} : { numberFormat }),
      ...(formula === undefined ? {} : { formula }),
      ...(sharedFormulaOrigin === undefined ? {} : { sharedFormulaOrigin })
    });
  }

  return {
    cells,
    merges,
    columns,
    rowHeights,
    rowStyles,
    sheetProperties,
    headerFooter,
    margins,
    pageSetup,
    formatInfo,
    unreadRecords,
    unknownRecords,
    undecodedFormulas,
    errorCells,
    ...(drawingRelationshipId === undefined ? {} : { drawingRelationshipId })
  };
}

/**
 * Read the token stream out of a formula cell.
 *
 * The record is `Cell`, the cached value, a flags word, then `CellParsedFormula`. Skipping
 * to the tokens therefore needs the cached value's width, which differs per record — so the
 * record name selects it rather than a fixed offset.
 *
 * @returns Formula text, a shared-formula origin, or `undefined` when it could not be
 *          decoded. The distinction matters: the first two are successes.
 */
function readFormula(
  record: BiffRecord,
  part: string,
  name: string,
  row: number,
  column: number,
  context: PtgContext
): string | { row: number; column: number } | undefined {
  const where = `${part} ${encodeCol(column)}${row + 1}`;
  try {
    const reader = new BinaryReader(record.payload, 0, part);
    readCell(reader);
    switch (name) {
      case "BrtFmlaNum":
        reader.readFloat64();
        break;
      case "BrtFmlaBool":
      case "BrtFmlaError":
        reader.readUint8();
        break;
      case "BrtFmlaString": {
        const length = reader.readUint32();
        reader.skip(length * 2);
        break;
      }
      default:
        return undefined;
    }
    reader.readUint16(); // grbit: recalculation flags, not expression structure.
    const tokens = reader.readBytes(reader.readUint32());
    const decoded = decodePtg(tokens, { ...context, origin: { row, column } }, where);
    return "sharedRow" in decoded
      ? { row: decoded.sharedRow, column: decoded.sharedColumn }
      : printAst(decoded);
  } catch {
    // Every failure mode is the same outcome for the caller: the cached value stands and
    // the expression is reported. Distinguishing them here would put codec detail in the
    // reader's contract.
    return undefined;
  }
}

function readCellValue(
  decoded: DecodedRecord | undefined,
  name: string,
  sharedStrings: readonly string[]
): string | number | boolean | null | undefined {
  switch (name) {
    case "BrtCellBlank":
      return null;
    case "BrtCellRk":
    case "BrtCellReal":
      return numberField(decoded, "value");
    case "BrtCellBool": {
      const raw = numberField(decoded, "value");
      return raw === undefined ? undefined : raw !== 0;
    }
    case "BrtCellSt": {
      const text = decoded?.fields.get("value");
      return typeof text === "string" ? text : undefined;
    }
    case "BrtCellIsst": {
      const index = numberField(decoded, "isst");
      // An out-of-range index is a broken file, which the validator reports. Here it
      // becomes undefined rather than an empty string, so the cell is counted as unread
      // instead of silently becoming blank.
      return index === undefined ? undefined : sharedStrings[index];
    }
    // A formula cell's cached result. The declared layout stops after it — the flags word
    // and token stream that follow are read separately by `readFormula`, and appear here as
    // the record's trailing bytes.
    case "BrtFmlaNum":
    case "BrtFmlaBool":
      return name === "BrtFmlaBool"
        ? numberField(decoded, "value") !== 0
        : numberField(decoded, "value");
    case "BrtFmlaString": {
      const text = decoded?.fields.get("value");
      return typeof text === "string" ? text : undefined;
    }
    case "BrtFmlaError":
    case "BrtCellError": {
      // The cached value is an error code. Mapped to null rather than invented as a string:
      // the model's error representation is a separate concern from reading the record, and
      // the cell's existence is what matters here.
      const code = numberField(decoded, "error");
      return code === undefined ? undefined : null;
    }
    default:
      return undefined;
  }
}
