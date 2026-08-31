/**
 * The worksheet part: `xl/worksheets/sheetN.bin`.
 *
 * The order of the records is Excel's own, and it is not cosmetic. A workbook this library wrote with
 * the sheet's *views* missing satisfied every structural rule its validator knew and Excel refused to
 * open it — a sheet with no view has nowhere to be displayed. So the sequence below mirrors nine
 * Excel-authored workbooks record for record, and `record-missing-required` in the validator is what
 * keeps it that way rather than this function's comments.
 */
import type { HeaderFooter, Margins } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import {
  COLUMN_WIDTH_UNITS,
  TWIPS_PER_POINT,
  encodeBiffRecords,
  encodeCell,
  encodeRange,
  type BiffRange
} from "@excel/xlsb/binary";
import { printOptions, selection, sheetProtection, worksheetView } from "@excel/xlsb/defaults";
import { encodeDrawing } from "@excel/xlsb/drawing";
import type { PtgContext } from "@excel/xlsb/formula/ptg";
import { encodeHeaderFooter, hasHeaderFooter } from "@excel/xlsb/header-footer";
import {
  encodeMargins,
  encodePageSetup,
  encodeSheetFormatInfo,
  type ReadPageSetup,
  type SheetFormatInfo
} from "@excel/xlsb/page-setup";
import { encodeSheetProperties, type SheetProperties } from "@excel/xlsb/sheet-properties";
import { INFERRED_VALUES } from "@excel/xlsb/spec/records";
import { internStyle, type CellFormatTable } from "@excel/xlsb/styles";
import { encodeCellRecord, usedRange } from "@excel/xlsb/write/cells";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import type { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import { type SheetColumn, type SheetRow } from "@excel/xlsb/write/types";
import { BinaryWriter } from "@utils/binary";

/** Excel's default row height, in the twips a row header carries. */
const DEFAULT_ROW_HEIGHT_TWIPS = 15 * TWIPS_PER_POINT;

export interface WrittenWorksheet {
  readonly bytes: Uint8Array;
  /**
   * Cells whose content could not be expressed, as `A1: reason`.
   *
   * Collected here rather than classified before serialisation, because whether a formula
   * can be encoded is not knowable from the model — it depends on the tokens it needs and on
   * whether the workbook defines the names it references. An earlier version decided up
   * front and therefore reported nothing when the encoder later refused, which is precisely
   * the silent loss the report exists to prevent.
   */
  readonly unsupported: readonly string[];
}

/**
 * Everything `writeWorksheetPart` needs.
 *
 * **One options object, not seven parameters.** This grew to six positional arguments plus a bag, which
 * is the shape a function takes when each new capability is appended rather than placed: nothing at the
 * call site said which of `merges` and `columns` came first, and a caller that wanted only the last
 * option had to supply five defaults to reach it. Every input is now named at the call site, and adding
 * one is a field rather than a decision about ordering.
 *
 * Named rather than left inline so a caller — the package assembler, a test, a future streaming writer
 * — can refer to the contract instead of reaching for `Parameters<typeof writeWorksheetPart>[0]`, and
 * so the two fields with a lifetime beyond one call have somewhere to say so.
 */
export interface WriteWorksheetPartOptions {
  /** Rows in any order; they are sorted here, because the format requires ascending row numbers. */
  readonly rows: readonly SheetRow[];
  /**
   * Interned strings, filled as the cells are written and serialised by the caller afterwards.
   *
   * Required, like `formats`, because it is *shared across sheets*: the caller owns it, passes the same
   * one to every sheet and writes `sharedStrings.bin` from it at the end.
   */
  readonly strings: SharedStringTable;
  /** What a formula's sheet and name references resolve against. */
  readonly formulaContext?: PtgContext;
  /**
   * Cell formats, interned as the cells are written.
   *
   * Required for the same reason `strings` is, and it was optional — defaulting to a fresh table
   * this function then kept to itself. Any sheet with a style therefore wrote non-zero style indices
   * into a table the caller never received and could not serialise, so the part came out referring to
   * `styles.bin` entries that would not exist. An optional argument whose default cannot produce a
   * consistent package is not a convenience.
   */
  readonly formats: CellFormatTable;
  readonly merges?: readonly BiffRange[];
  readonly columns?: readonly SheetColumn[];
  /** Paper, scaling, orientation and margins. */
  readonly pageSetup?: ReadPageSetup & { readonly margins?: Partial<Margins> };
  /** Default row height and column width. */
  readonly formatInfo?: SheetFormatInfo;
  /** Tab colour and VBA code name. */
  readonly sheetProperties?: SheetProperties;
  /**
   * Relationship id of the sheet's drawing part, when it has one.
   *
   * The part itself is XML and shared with the XLSX path; only this reference is binary.
   */
  readonly drawingRelationshipId?: string;
  /** What the sheet prints at the top and bottom of each page. */
  readonly headerFooter?: Partial<HeaderFooter>;
}

/**
 * Serialise one `xl/worksheets/sheetN.bin`.
 *
 * The record order is Excel's, established by comparing against nine of its own workbooks, and is
 * asserted by the validator rather than left to this function's reading order.
 */
export function writeWorksheetPart(options: WriteWorksheetPartOptions): WrittenWorksheet {
  const {
    rows,
    strings,
    formulaContext = {},
    formats,
    merges = [],
    columns = [],
    pageSetup,
    formatInfo,
    sheetProperties,
    drawingRelationshipId,
    headerFooter
  } = options;
  const records: Emitted[] = [record("BrtBeginSheet")];
  // First in every reference workbook, before the dimension — and it carries the VBA code name,
  // which a preserved `vbaProject.bin` needs in order to resolve its own sheets. Emitted
  // unconditionally because Excel does: a sheet with no tab colour still has properties.
  records.push(record("BrtWsProp", encodeSheetProperties(sheetProperties)));
  records.push(record("BrtWsDim", encodeRange(usedRange(rows))));

  // A worksheet must declare at least one view before it declares any content. This library wrote
  // none, which is one of the reasons Excel rejected its output — a sheet with no view has nowhere
  // to be displayed.
  records.push(
    record("BrtBeginWsViews"),
    record("BrtBeginWsView", worksheetView()),
    record("BrtSel", selection()),
    record("BrtEndWsView"),
    record("BrtEndWsViews")
  );

  // Always, as Excel does: a consumer needs the sheet's defaults before it can interpret a row that
  // omits its height, and `undefined` here means "the defaults" rather than "no answer".
  records.push(record("BrtWsFmtInfo", encodeSheetFormatInfo(formatInfo)));
  // Column widths come before the cell data: a consumer sizes its columns before it has rows
  // to put in them, and the validator's ordering rules place the collection here.
  if (columns.length > 0) {
    records.push(
      // No payload. Excel writes this collection header empty — unlike the styles collections,
      // which do carry a count — and a four-byte count where Excel has none is a record Excel
      // cannot parse.
      record("BrtBeginColInfos")
    );
    for (const column of columns) {
      records.push(
        record(
          "BrtColInfo",
          new BinaryWriter()
            .writeUint32(column.firstColumn)
            .writeUint32(column.lastColumn)
            .writeUint32(Math.round(column.widthCharacters * COLUMN_WIDTH_UNITS))
            // The column's own cell format, in the same position as a row's. Written as 0 before,
            // which is why `ColumnModel.style` had no path out.
            .writeUint32(internStyle(formats, column))
            // fUserSet: the width was set deliberately, so Excel keeps it rather than
            // recomputing one. Without it a written width is advisory and usually ignored.
            .writeUint16(0x02)
            .toUint8Array()
        )
      );
    }
    records.push(record("BrtEndColInfos"));
  }

  records.push(record("BrtBeginSheetData"));
  const unsupported: string[] = [];

  // Rows must ascend, and cells within a row must ascend by column: a streaming reader
  // relies on both, and the validator enforces the first. Sorting here rather than
  // trusting the caller means a model built in any order still produces a valid part.
  for (const row of [...rows].sort((left, right) => left.row - right.row)) {
    // The inclusive column range the row's cells occupy, which the row header declares so a
    // consumer can size its buffers before reading them. A row with no cells declares no span.
    // One pass, no array. `Math.min(...columns)` allocated a copy of every row's columns and then
    // spread it into an argument list, which for a wide enough row is not merely wasteful — it is a
    // call that can exceed the engine's argument limit.
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    for (const cell of row.cells) {
      if (cell.column < first) {
        first = cell.column;
      }
      if (cell.column > last) {
        last = cell.column;
      }
    }
    const span = last < 0 ? undefined : { first, last };
    records.push(
      record(
        "BrtRowHdr",
        new BinaryWriter()
          .writeUint32(row.row)
          // The row's own cell format. This field was written unconditionally as 0 while
          // `SheetRow.styleIndex` was never populated, so `RowModel.style` had no path out at all.
          .writeUint32(internStyle(formats, row))
          .writeUint16(
            row.heightPoints === undefined
              ? DEFAULT_ROW_HEIGHT_TWIPS
              : Math.round(row.heightPoints * TWIPS_PER_POINT)
          )
          // fUnsynced: the height is the row's own rather than derived from the font, which is
          // what makes a custom height stick. Every row in the reference corpus is exactly its
          // sheet's default height with this clear, so the flag's use is inferred rather than
          // observed — see `INFERRED_VALUES`.
          .writeUint16(row.heightPoints === undefined ? 0 : INFERRED_VALUES.rowHeightUnsynced)
          // The rest of the record, and it is not optional. Every `BrtRowHdr` Excel writes is
          // **25 bytes**; this writer emitted twelve, so every row in every file it produced was
          // short by thirteen — which is not a field read wrong but a truncated record, and enough
          // on its own for Excel to reject the package.
          //
          // The tail is a byte, then a count of column spans, then that many `{first, last}` pairs.
          // The reading is confirmed by the spans themselves: a row with two cells in columns 0 and
          // 1 carries `ccolspan = 1` and `{0, 1}` in every corpus workbook.
          .writeUint8(0)
          // Always one span, so the record is always 25 bytes. A row with no cells is not a shape
          // the corpus contains — every reference row has cells — so a shorter "no spans" form is
          // unobserved, and writing an unobserved form of a record whose length Excel never varies
          // is exactly the kind of guess this module does not make. `{0, 0}` sizes a consumer's
          // buffer for one column; it does not claim a cell exists there.
          .writeUint32(1)
          .writeUint32(span?.first ?? 0)
          .writeUint32(span?.last ?? 0)
          .toUint8Array()
      )
    );
    for (const cell of [...row.cells].sort((left, right) => left.column - right.column)) {
      const address = `${encodeCol(cell.column)}${cell.row + 1}`;
      if (cell.unsupported) {
        unsupported.push(`${address}: ${cell.unsupported}`);
      }
      // Interned once, because both branches below need it. Reading it back off `cell` in the
      // rejection branch is what made a cell whose formula could not be encoded lose its number
      // format and font as well: `SheetCell.styleIndex` is never populated by the model reader,
      // so that branch always fell back to 0 — the "no formatting" entry.
      const styleIndex = internStyle(formats, cell);
      const emitted = encodeCellRecord({ ...cell, styleIndex }, strings, formulaContext);
      if (emitted === undefined) {
        // The encoder refused. A blank keeps the cell's position *and its formatting*; only the
        // formula is lost, and the reason is reported.
        unsupported.push(`${address}: formula`);
        records.push(record("BrtCellBlank", encodeCell({ column: cell.column, styleIndex })));
        continue;
      }
      records.push(emitted);
    }
  }

  records.push(record("BrtEndSheetData"));

  // After the cell data, which is where the validator's ordering rule expects it: a consumer
  // reads the cells and then learns which of them are covered by a merge.
  if (merges.length > 0) {
    records.push(
      record("BrtBeginMergeCells", new BinaryWriter().writeUint32(merges.length).toUint8Array())
    );
    for (const merge of merges) {
      records.push(record("BrtMergeCell", encodeRange(merge)));
    }
    records.push(record("BrtEndMergeCells"));
  }

  // Page setup goes after the cell data, which is the order every reference workbook uses. The
  // margins are written whenever the sheet has any page setup at all, because a file that
  // declares a paper size and no margins would print with the consumer's defaults rather than
  // the author's.
  // Sheet protection and print options come between the cell data and the margins, which is the
  // order every reference workbook uses. Neither is interpreted here; both are emitted because
  // Excel emits them and a file missing a record every real file has is a file this library has no
  // evidence is acceptable.
  records.push(record("BrtSheetProtection", sheetProtection()));
  records.push(record("BrtPrintOptions", printOptions()));
  records.push(record("BrtMargins", encodeMargins(pageSetup?.margins)));
  records.push(record("BrtPageSetup", encodePageSetup(pageSetup)));

  // After the margins, which is where `picture.xlsb` puts it. A sheet has at most one drawing —
  // every picture and shape on it is an anchor inside that one part — so this is a single id rather
  // than a collection.
  // Between the page setup and the drawing, which is the order `date.xlsb` uses. Written only when
  // the sheet says something: an empty header/footer pair is a scope with nothing in it.
  if (hasHeaderFooter(headerFooter)) {
    records.push(
      record("BrtBeginHeaderFooter", encodeHeaderFooter(headerFooter)),
      record("BrtEndHeaderFooter")
    );
  }

  if (drawingRelationshipId !== undefined) {
    records.push(record("BrtDrawing", encodeDrawing(drawingRelationshipId)));
  }

  records.push(record("BrtEndSheet"));
  return { bytes: encodeBiffRecords(records), unsupported };
}
