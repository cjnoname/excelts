/**
 * `BrtTableStyleClient` — which table style paints a table or a PivotTable.
 *
 * One record, two producers. A table's part ends with it and a PivotTable's `BrtBeginSXView` collection
 * contains it, and in both cases it is two flag bytes then the style name as an `XLWideString`.
 *
 * **The six flags are one word shared by both producers, and each producer uses a different subset of it** —
 * which is the whole reason this is a named-flag API rather than a number at each call site. A table names
 * the four stripe/edge toggles that `<tableStyleInfo>` carries; a PivotTable names the two header toggles
 * from `<pivotTableStyleInfo>` and shares `fLastColumn`. The bit assignment below is not read off a field
 * list: Excel's own PivotTable bytes are `0x32`, which is `fLastColumn | fRowHeaders | fColumnHeaders`, and
 * that is exactly the three attributes the corresponding XML sets. A table with all four toggles off is
 * `0x0000`, which Excel also confirms. Two independent readings of the same word agreeing is what pins it.
 *
 * The PivotTable side used to hold this inline with **both the flags and the style name hardcoded**, which
 * made it right for one pivot and wrong for any other — a latent defect of the same kind as the table side
 * having no such record at all. Passing the flags through here means a caller states what it means and the
 * bits are computed in one place.
 */
import { encodeWideString } from "@excel/xlsb/binary";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * The six `TableStyleClient` flags, MS-XLSB 2.4.815.
 *
 * Named rather than positional so a call site reads as the XML attribute it comes from. The remaining ten
 * bits of the word are reserved and stay clear.
 */
export interface TableStyleFlags {
  /** `fFirstColumn` — emphasise the first column. */
  readonly firstColumn?: boolean;
  /** `fLastColumn` — emphasise the last column. Used by both a table and a PivotTable. */
  readonly lastColumn?: boolean;
  /** `fRowStripes` — band alternate rows. */
  readonly rowStripes?: boolean;
  /** `fColumnStripes` — band alternate columns. */
  readonly columnStripes?: boolean;
  /** `fRowHeaders` — emphasise row headers. A PivotTable concept; a table has no equivalent attribute. */
  readonly rowHeaders?: boolean;
  /** `fColumnHeaders` — emphasise column headers. Likewise. */
  readonly columnHeaders?: boolean;
}

const BIT = {
  firstColumn: 0x0001,
  lastColumn: 0x0002,
  rowStripes: 0x0004,
  columnStripes: 0x0008,
  rowHeaders: 0x0010,
  columnHeaders: 0x0020
} as const satisfies Record<keyof TableStyleFlags, number>;

/** Pack the named flags into the record's `u16`. */
export function tableStyleFlagWord(flags: TableStyleFlags): number {
  let word = 0;
  for (const [name, bit] of Object.entries(BIT)) {
    if (flags[name as keyof TableStyleFlags] === true) {
      word |= bit;
    }
  }
  return word;
}

/**
 * `BrtTableStyleClient`'s payload: the flag word, then the style name.
 *
 * The name is an `XLWideString` and therefore **not** nullable — a producer with no style of its own passes
 * the built-in default it actually wants rather than omitting the record, because omitting it is what left
 * tables unstyled.
 */
export function encodeTableStyleClient(styleName: string, flags: TableStyleFlags): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint16(tableStyleFlagWord(flags)).toUint8Array(),
    encodeWideString(styleName)
  ]);
}
