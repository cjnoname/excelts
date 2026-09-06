/**
 * The shared-string table, and the part it becomes.
 *
 * Interning is what makes a binary workbook small for the data people actually put in one: a column of
 * ten thousand region names stores five strings and ten thousand four-byte indices. The table therefore
 * has to be filled while the cells are written and serialised afterwards, which is why it is a mutable
 * object passed down rather than a value returned up.
 *
 * ## Rich text
 *
 * An entry is either plain text or a `RichStr` — the same string with a list of formatting runs. Both live in
 * the same table because both are `BrtSSTItem`, and a cell refers to either by the same index.
 *
 * A run names its font by `ifnt`, an index into the `BrtFont` collection in `xl/styles.bin`. That is why
 * `intern` takes the cell-format table: the run's font has to be interned into *that* collection rather than a
 * private one, or the index would point at whatever font a cell happened to use. Rich text was reported as
 * unwritable until this existed, and the reason given — that the runs could not be expressed — was really
 * that the font table was out of reach from here.
 */
import type { Font } from "@excel/types";
import { encodeBiffRecords, encodeWideString } from "@excel/xlsb/binary";
import type { CellFormatTable } from "@excel/xlsb/styles";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** One formatting run of a rich string: where it starts, and the font it uses. */
interface StringRun {
  /** Zero-based character index into the whole string, which is what `StrRun.ich` carries. */
  readonly at: number;
  /** `ifnt` — an index into the styles part's font collection. */
  readonly font: number;
}

/** A table entry: the text, and the runs when it is rich. */
interface StringEntry {
  readonly text: string;
  readonly runs?: readonly StringRun[];
}

/** A rich-text run as the model spells it. */
export interface RichTextRun {
  readonly text?: string;
  readonly font?: Partial<Font>;
}

/**
 * Shared-string table being accumulated while worksheets are written.
 *
 * Built as the cells are visited rather than in a pass of its own, because the index a
 * cell needs is the position in this table and the table is defined by the order the
 * cells are visited in. Two passes would have to agree on that order.
 */
export class SharedStringTable {
  private readonly indexByKey = new Map<string, number>();
  readonly entries: StringEntry[] = [];
  /** Total occurrences, which `BrtBeginSst` carries alongside the unique count. */
  private total = 0;

  intern(text: string): number {
    return this.add(`p\u0000${text}`, { text });
  }

  /**
   * Intern a rich string, folding its runs' fonts into `formats`.
   *
   * The runs are derived from the model's list rather than carried from it: the model gives each run its own
   * text, while `RichStr` stores one string and marks where each run *begins*. A run with no font of its own
   * still needs an entry, because the run after it must not inherit the font of the run before — `ifnt` 0, the
   * default font, is what "no formatting" means here.
   *
   * A single run covering the whole string is written as a rich string anyway rather than flattened to plain
   * text: it carries a font, and flattening would drop it.
   */
  internRich(runs: readonly RichTextRun[], formats: CellFormatTable): number {
    let text = "";
    const positions: StringRun[] = [];
    for (const run of runs) {
      positions.push({ at: text.length, font: formats.internFont(run.font) });
      text += run.text ?? "";
    }
    // Runs with nothing to format are dropped, which is the one case where a rich string and a plain one are
    // the same thing — `text` is then the whole content and there is no font to lose.
    const meaningful = positions.filter(
      (position, index) => position.font !== 0 || index > 0 || positions.length > 1
    );
    if (meaningful.length === 0) {
      return this.intern(text);
    }
    return this.add(
      `r\u0000${text}\u0000${meaningful.map(run => `${run.at}:${run.font}`).join(",")}`,
      { text, runs: meaningful }
    );
  }

  private add(key: string, entry: StringEntry): number {
    this.total++;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.entries.length;
    this.indexByKey.set(key, index);
    this.entries.push(entry);
    return index;
  }

  get occurrences(): number {
    return this.total;
  }

  /** The plain texts, in table order. Kept for callers that only need the strings. */
  get texts(): readonly string[] {
    return this.entries.map(entry => entry.text);
  }
}

/** Serialise `xl/sharedStrings.bin`. */
export function writeSharedStrings(table: SharedStringTable): Uint8Array {
  const records: Emitted[] = [
    record(
      "BrtBeginSst",
      new BinaryWriter()
        .writeUint32(table.occurrences)
        .writeUint32(table.entries.length)
        .toUint8Array()
    )
  ];
  for (const entry of table.entries) {
    // Flag bit 0 is `fRichStr` — "`dwSizeStrRun` and `rgsStrRun` follow". Bit 1 is `fExtStr`, phonetic data,
    // which nothing here produces. Verified against `poi-sample.xlsb`, whose rich entries are
    // `01 <cch> <chars> <count> [<ich> <ifnt>]…`.
    records.push(
      record(
        "BrtSSTItem",
        entry.runs === undefined
          ? concatUint8Arrays([Uint8Array.of(0), encodeWideString(entry.text)])
          : concatUint8Arrays([
              Uint8Array.of(0x01),
              encodeWideString(entry.text),
              new BinaryWriter().writeUint32(entry.runs.length).toUint8Array(),
              ...entry.runs.map(run =>
                new BinaryWriter().writeUint16(run.at).writeUint16(run.font).toUint8Array()
              )
            ])
      )
    );
  }
  records.push(record("BrtEndSst"));
  return encodeBiffRecords(records);
}
