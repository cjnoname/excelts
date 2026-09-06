import type { WorksheetEvent } from "@excel/stream/worksheet-reader";
import { WorksheetReader } from "@excel/stream/worksheet-reader";
/**
 * The XLSB worksheet reader `Stream.WorkbookReader` hands out for a binary package.
 *
 * **A subclass, not a parallel class.** Everything a caller touches — `id`, `name`, `state`, `sheetNo`, the event
 * emitter, `destroy()` — is `WorksheetReader`'s, and only `parse()` is replaced. So a caller's loop is the same loop,
 * and a field added to the reader surface reaches the binary path without an edit. The XML `parse()` walks SAX events;
 * this walks BIFF12 records through `streamXlsbRows`.
 *
 * The alternative was a second class implementing the same shape, and it would have drifted: this module's most
 * repeated defect is two code paths that agree with each other and not with the format, and two reader classes with
 * one documented surface is that arrangement waiting to happen.
 *
 * What a streamed binary read does and does not surface is stated in `xlsb-worksheet-reader.ts` — measured against the
 * buffered reader rather than assumed, and the reason `row` is the only event kind emitted here.
 */
import { streamXlsbRows } from "@excel/stream/xlsb-worksheet-reader";

/** What the workbook reader must supply for a binary sheet's cells to be resolvable. */
export interface XlsbWorksheetContext {
  /** The shared-string table, indexed by `BrtCellIsst`. */
  readonly sharedStrings: readonly string[];
  /** Number formats by style index, so a serial wearing a date format becomes a `Date`. */
  readonly numberFormats?: readonly (string | undefined)[];
  /** `date1904`, from the workbook part. */
  readonly date1904?: boolean;
  /** The part path, for error messages that name where a malformed record was. */
  readonly part: string;
}

class XlsbWorksheetReader extends WorksheetReader {
  /**
   * Set by the workbook reader after construction.
   *
   * Assigned rather than taken through the constructor because `WorksheetReader`'s signature is shared with the XML
   * path and widening it would put a binary-only parameter on both. The workbook reader is the only caller.
   */
  xlsbContext?: XlsbWorksheetContext;

  /**
   * Rows from the record stream.
   *
   * Yields the same `WorksheetEvent[]` batches the XML reader does — one event per row — so a caller consuming either
   * container writes one loop. `worksheets: "ignore"` returns immediately, which is what makes a package's other
   * sheets skippable without decoding them.
   */
  async *parse(): AsyncIterableIterator<WorksheetEvent[]> {
    if (this.options.worksheets !== "emit") {
      return;
    }
    const context = this.xlsbContext;
    if (context === undefined) {
      // A programming error rather than a bad file: the workbook reader constructs this and then supplies the tables.
      throw new Error("xlsb: worksheet reader used without its workbook context");
    }
    for await (const row of streamXlsbRows(
      this.iterator as AsyncIterable<Uint8Array>,
      context.part,
      {
        sharedStrings: context.sharedStrings,
        ...(context.numberFormats === undefined ? {} : { numberFormats: context.numberFormats }),
        ...(context.date1904 === undefined ? {} : { date1904: context.date1904 }),
        worksheet: this as never
      }
    )) {
      yield [{ eventType: "row", value: row }];
    }
  }
}

export { XlsbWorksheetReader };
