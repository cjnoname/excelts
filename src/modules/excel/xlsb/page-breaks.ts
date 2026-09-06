import { XLSB_MAX_COLUMNS, XLSB_MAX_ROWS } from "@excel/xlsb/binary";
/**
 * Page breaks: `BrtBrk` inside a `BrtBeginRwBrk` or `BrtBeginColBrk` scope.
 *
 * **The record does not say which axis it is on.** All three of its indices are `Rw_Col` — an untyped
 * 32-bit index — and their meaning comes entirely from which scope encloses the record. In a row-break
 * scope `unRwCol` is a row and the other two bound it across columns; in a column-break scope the roles
 * swap. So there is one codec here taking an axis, rather than two that would drift.
 *
 * Layout from MS-XLSB 2.4.315, whose own example is the fixture below: a horizontal break at row 8
 * spanning columns A to Z is `unRwCol = 7`, `unColRwStrt = 0`, `unColRwEnd = 25`.
 *
 * No workbook in the pinned corpus contains one, so the layout is the specification's and the values
 * are registered as inferred. What made this worth writing anyway is that absence: the corpus is
 * twenty-three *test fixtures*, not a sample of what people build, and a page break is something a
 * person sets deliberately on a sheet they intend to print.
 */
import { BinaryReader, BinaryWriter } from "@utils/binary";

/** Which collection a break belongs to, and therefore what its indices mean. */
export type BreakAxis = "row" | "column";

/**
 * One page break, in the model's shape.
 *
 * `id` is the row or column the break sits *before*, one-based as the public API and the XLSX model use
 * it. `min`/`max` bound the break across the other axis; `man` records whether a person placed it or
 * Excel did when the content overflowed the page.
 */
export interface SheetBreak {
  readonly id: number;
  readonly min?: number;
  readonly max: number;
  readonly man: number;
}

/** Serialise a `BrtBrk`. */
export function encodeBreak(entry: SheetBreak, axis: BreakAxis): Uint8Array {
  // The model is one-based on both axes and the record is zero-based on both. Converting here rather
  // than at the call sites is the point of this module: the row and column paths differ only in which
  // limit they clamp to, and a conversion written twice is a conversion that ends up applied once.
  const limit = axis === "row" ? XLSB_MAX_ROWS : XLSB_MAX_COLUMNS;
  const across = axis === "row" ? XLSB_MAX_COLUMNS : XLSB_MAX_ROWS;
  return (
    new BinaryWriter()
      .writeUint32(clamp(entry.id - 1, limit))
      .writeUint32(clamp((entry.min ?? 1) - 1, across))
      .writeUint32(clamp(entry.max - 1, across))
      // `fMan`: set when a person placed the break. An automatic break is Excel's own pagination and is
      // recomputed on open, so writing one back would pin a decision nobody made.
      .writeUint32(entry.man === 0 ? 0 : 1)
      // `fPivot`: this writer does not model pivot tables, so a break it emits is never one of theirs.
      .writeUint32(0)
      .toUint8Array()
  );
}

/** Read a `BrtBrk`, or `undefined` when the payload is short. */
export function readBreak(payload: Uint8Array, part: string): SheetBreak | undefined {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const id = reader.readUint32();
    const min = reader.readUint32();
    const max = reader.readUint32();
    const man = reader.readUint32();
    return { id: id + 1, min: min + 1, max: max + 1, man: man === 0 ? 0 : 1 };
  } catch {
    // A truncated record costs that break, not the sheet.
    return undefined;
  }
}

/** A zero-based index the record can hold. */
function clamp(value: number, limit: number): number {
  return Math.max(0, Math.min(Math.trunc(value), limit - 1));
}
