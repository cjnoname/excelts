/**
 * The shared-string table, and the part it becomes.
 *
 * Interning is what makes a binary workbook small for the data people actually put in one: a column of
 * ten thousand region names stores five strings and ten thousand four-byte indices. The table therefore
 * has to be filled while the cells are written and serialised afterwards, which is why it is a mutable
 * object passed down rather than a value returned up.
 */
import { encodeBiffRecords, encodeWideString } from "@excel/xlsb/binary";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * Shared-string table being accumulated while worksheets are written.
 *
 * Built as the cells are visited rather than in a pass of its own, because the index a
 * cell needs is the position in this table and the table is defined by the order the
 * cells are visited in. Two passes would have to agree on that order.
 */
export class SharedStringTable {
  private readonly indexByText = new Map<string, number>();
  readonly texts: string[] = [];
  /** Total occurrences, which `BrtBeginSst` carries alongside the unique count. */
  private total = 0;

  intern(text: string): number {
    this.total++;
    const existing = this.indexByText.get(text);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.texts.length;
    this.indexByText.set(text, index);
    this.texts.push(text);
    return index;
  }

  get occurrences(): number {
    return this.total;
  }
}

/** Serialise `xl/sharedStrings.bin`. */
export function writeSharedStrings(table: SharedStringTable): Uint8Array {
  const records: Emitted[] = [
    record(
      "BrtBeginSst",
      new BinaryWriter()
        .writeUint32(table.occurrences)
        .writeUint32(table.texts.length)
        .toUint8Array()
    )
  ];
  for (const text of table.texts) {
    // Flag byte 0: a plain string, with neither formatting runs nor phonetic data.
    records.push(
      record("BrtSSTItem", concatUint8Arrays([Uint8Array.of(0), encodeWideString(text)]))
    );
  }
  records.push(record("BrtEndSst"));
  return encodeBiffRecords(records);
}
