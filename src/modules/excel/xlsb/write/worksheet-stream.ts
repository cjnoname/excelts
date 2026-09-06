/**
 * A sheet part written **forward, one row at a time**, into a `PartWriter`.
 *
 * This is the third of the four write paths named in `utils/package-sink.ts` — the one that did not exist. The
 * other three all had the rows in hand before they began; this one is handed them as they arrive and may not
 * keep them, which is the whole point: `Stream.WorkbookWriter` exists so that a workbook larger than memory can
 * be written, and a `format: "xlsb"` that buffered every row would satisfy the signature while giving up the
 * only property the caller came for.
 *
 * **It is not a second serialiser.** Every byte comes from the same three functions the buffered writer uses —
 * `worksheetPrologueRecords`, `encodeRowRecords`, `worksheetEpilogueRecords` — because this module has produced
 * the same defect seven times: a reader and a writer, or two writers, sharing one wrong belief and agreeing
 * with each other while disagreeing with Excel. Two row encoders would be an eighth. What this file adds is
 * *when* those records are emitted, not what they are, and `__tests__/xlsb-streaming-sheet.test.ts` asserts the
 * output is byte-identical to `writeWorksheetPart` for the same input.
 *
 * **The one thing given up is `BrtWsDim`.** It states the used range and sits before the rows, so a forward pass
 * cannot fill it in. Excel writes it in every reference workbook, so whether it may be omitted was a question
 * about Excel rather than about the specification — and it was answered by opening a package without it, which
 * Excel does without a repair. See `omitDimension` in `xlsb/write/worksheet.ts`.
 *
 * **What is still bounded by the workbook, not by the rows**: the shared-string table and the style table. Both
 * are proportional to *distinct* values rather than to cells, both are needed to write `sharedStrings.bin` and
 * `styles.bin` at the end, and the streaming XLSX writer holds exactly the same two. Calling this "streaming"
 * while holding them is therefore the same claim that writer already makes, not a weaker one.
 */
import type { PartWriter } from "@excel/utils/package-sink";
import { encodeBiffRecords } from "@excel/xlsb/binary";
import type { Emitted } from "@excel/xlsb/write/emit";
import type { SheetRow } from "@excel/xlsb/write/types";
import type { WriteWorksheetPartOptions } from "@excel/xlsb/write/worksheet";
import {
  encodeRowRecords,
  worksheetEpilogueRecords,
  worksheetPrologueRecords
} from "@excel/xlsb/write/worksheet";

/**
 * Options for a streamed sheet part.
 *
 * `rows` is deliberately absent: they arrive through `row()`. Everything else is the buffered writer's own
 * option type, so a caller that already builds one of those does not learn a second vocabulary — and a field
 * added there is available here without an edit.
 */
export type StreamWorksheetPartOptions = Omit<WriteWorksheetPartOptions, "rows" | "omitDimension">;

/** A sheet part being written forward. Rows in order; `end()` closes it. */
export interface WorksheetPartStream {
  /**
   * Append one row.
   *
   * Rows must arrive in ascending order. That is not checked, and the reason is worth stating rather than
   * leaving as an omission: a forward writer has already emitted the preceding rows, so it could only report
   * the problem, not fix it — and the caller that would trip it (`Stream.WorkbookWriter`) commits rows in order
   * by construction. Excel reads an out-of-order `BrtRowHdr` sequence as a corrupt sheet.
   */
  row(row: SheetRow): void;
  /** Close the part: epilogue records, then the underlying writer's `end()`. */
  end(): void;
  /** Losses accumulated so far, in the same form `writeWorksheetPart` reports them. */
  readonly unsupported: readonly string[];
}

/**
 * Begin a sheet part, writing its prologue immediately.
 *
 * The prologue goes down before any row, which means everything it describes — columns, panes, views, sheet
 * properties, format info — must be settled by the time this is called. That is the same constraint the
 * streaming XLSX writer works under (it emits `<worksheet>`, the views and the columns before `<sheetData>`),
 * so it is a property of writing a spreadsheet forward rather than of this container.
 */
export function beginWorksheetPart(
  writer: PartWriter,
  // **A provider, called once for each half.** It used to take a resolved object, and the epilogue then re-used the
  // prologue's snapshot — so everything the epilogue describes was frozen at the first row, which is the opposite of
  // what the comment on `end()` claimed. Measured: a merge added after the first row produced zero `BrtMergeCell`
  // records, while the same merge added before it produced one.
  //
  // Safe because the two halves read **disjoint** option sets — the prologue takes the columns, panes, views and sheet
  // properties, the epilogue the merges, conditional formats, validations, breaks, page setup, header/footer,
  // hyperlinks and table references. There is no field they could come to disagree about.
  options: () => StreamWorksheetPartOptions
): WorksheetPartStream {
  const unsupported: string[] = [];
  const opened = options();
  const { strings, formats, formulaContext = {} } = opened;
  // `omitDimension` is not a choice the caller gets to make here. A forward pass cannot state the used range,
  // so offering the option would only let a caller ask for a sheet this function cannot produce.
  const prologueOptions: WriteWorksheetPartOptions = { ...opened, rows: [], omitDimension: true };
  write(writer, worksheetPrologueRecords(prologueOptions));
  let ended = false;
  return {
    row(row: SheetRow): void {
      if (ended) {
        throw new Error("xlsb: row written after the sheet part was ended");
      }
      write(writer, encodeRowRecords(row, { strings, formats, formulaContext, unsupported }));
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      // The epilogue reads no rows — asserted in the buffered writer's tests, and the property that makes a single
      // forward pass possible at all. Merges, conditional formats and the rest are read **now**, by calling the
      // provider again, so a caller may still be filling them in while rows arrive. That is what this comment always
      // said; until the parameter became a provider it was reading the first row's snapshot instead.
      write(
        writer,
        worksheetEpilogueRecords({ ...options(), rows: [], omitDimension: true }, unsupported)
      );
      writer.end();
    },
    get unsupported(): readonly string[] {
      return unsupported;
    }
  };
}

/**
 * Serialise a batch of records and hand them over.
 *
 * Per batch rather than per record: `encodeBiffRecords` writes each record's header and payload, and a record
 * is at most a few kilobytes, so a batch is the natural unit — while one `write` per record would multiply the
 * call count by the number of cells for no benefit. Nothing is retained.
 */
function write(writer: PartWriter, records: readonly Emitted[]): void {
  if (records.length === 0) {
    return;
  }
  writer.write(encodeBiffRecords(records));
}
