/**
 * `BrtRowHdr` — a row's own record, shared by the whole-model writer and the streaming one.
 *
 * Extracted from `writeWorksheetPart`, where it was inline. That was fine while one caller existed; a
 * streaming writer is a second, and a row header assembled in two places is one that comes to disagree
 * about the field this comment is mostly about.
 *
 * **Every `BrtRowHdr` Excel writes is 25 bytes.** This writer once emitted twelve — every row in every
 * file it produced was short by thirteen, which is not a field read wrong but a truncated record, and
 * enough on its own for Excel to reject the package. The tail is a byte, then a count of column spans,
 * then that many `{first, last}` pairs; the reading is confirmed by the spans themselves, because a row
 * with cells in columns 0 and 1 carries `ccolspan = 1` and `{0, 1}` in every corpus workbook.
 */
import { BinaryWriter } from "@utils/binary";

/** Twips per point, for the row height. */
const TWIPS_PER_POINT = 20;

/**
 * `fUnsynced` — bit 5 of `BrtRowHdr`'s second flag byte, MS-XLSB 2.4.770.
 *
 * Exported so the reader tests the same bit the writer sets. It was `0x0002` in the inferred register while
 * the record's two flag bytes were declared as one `u16`, which put it in `fExtraDsc` — reader and writer
 * agreed on the wrong bit, and only the specification showed which one was right.
 */
export const ROW_FLAG_UNSYNCED = 1 << 5;

/** Excel's default row height, in twips — 15 points. */
const DEFAULT_ROW_HEIGHT_TWIPS = 300;

/** The row fields this record carries. */
export interface RowHeaderLike {
  /** Zero-based row index. */
  readonly row: number;
  readonly heightPoints?: number;
  /** `fDyZero` — the row is hidden. */
  readonly hidden?: boolean;
  /** `iOutLevel`, 0–7. */
  readonly outlineLevel?: number;
  /** `fCollapsed` — rows below it with a higher outline level are collapsed. */
  readonly collapsed?: boolean;
}

/**
 * Serialise a `BrtRowHdr`.
 *
 * `span` is the row's occupied column range, or `undefined` for a row with no cells. Always one span, so
 * the record is always 25 bytes: a row with no cells is not a shape the corpus contains, so a shorter
 * "no spans" form is unobserved — and writing an unobserved form of a record whose length Excel never
 * varies is exactly the kind of guess this module does not make. `{0, 0}` sizes a consumer's buffer for
 * one column; it does not claim a cell exists there.
 */
export function encodeRowHeader(
  row: RowHeaderLike,
  styleIndex: number,
  span: { readonly first: number; readonly last: number } | undefined
): Uint8Array {
  return (
    new BinaryWriter()
      .writeUint32(row.row)
      // The row's own cell format. Written unconditionally as 0 while `SheetRow.styleIndex` was never
      // populated, so `RowModel.style` had no path out at all.
      .writeUint32(styleIndex)
      .writeUint16(
        row.heightPoints === undefined
          ? DEFAULT_ROW_HEIGHT_TWIPS
          : Math.round(row.heightPoints * TWIPS_PER_POINT)
      )
      // **Three separate flag bytes, not a `u16` and a byte.** MS-XLSB 2.4.770 splits them:
      //
      //   offset 10   fExtraAsc, fExtraDsc, reserved1(6)
      //   offset 11   iOutLevel(3), fCollapsed, fDyZero, fUnsynced, fGhostDirty, fReserved
      //   offset 12   fPhShow, reserved2(7)
      //
      // This wrote `fUnsynced` as `0x0002` in a `u16` at offset 10, which little-endian puts in *offset 10
      // bit 1* — `fExtraDsc`, "pad the bottom of this row". `fUnsynced` is offset 11 bit 5. The reader read
      // the same wrong bit, so a custom height round-tripped through this library while Excel saw a row with
      // no manual height and unrequested bottom padding.
      //
      // The same byte carries `iOutLevel`, `fCollapsed` and `fDyZero`, which is why hidden rows, grouped rows
      // and collapsed rows were all on the loss list: the field they need was being overwritten by a flag in
      // the wrong place, not missing from the record.
      .writeUint8(0)
      .writeUint8(
        (Math.max(0, Math.min(7, Math.trunc(row.outlineLevel ?? 0))) & 0x07) |
          (row.collapsed === true ? 1 << 3 : 0) |
          (row.hidden === true ? 1 << 4 : 0) |
          (row.heightPoints === undefined ? 0 : ROW_FLAG_UNSYNCED)
      )
      .writeUint8(0)
      .writeUint32(1)
      .writeUint32(span?.first ?? 0)
      .writeUint32(span?.last ?? 0)
      .toUint8Array()
  );
}
