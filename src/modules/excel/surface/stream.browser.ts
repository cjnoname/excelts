/**
 * `Stream` namespace surface — browser entry.
 *
 * Same streaming surface as the Node `surface/stream.ts`, but the
 * writer/reader classes resolve to their browser variants (Web Streams,
 * no Node file-path sinks).
 */
export { WorkbookWriter } from "@excel/stream/workbook-writer.browser";
export { WorkbookReader } from "@excel/stream/workbook-reader.browser";

// --- streaming cell handle operations (operate on a `CellData`) ---
export {
  cellGetValue as getCellValue,
  cellSetValue as setCellValue,
  cellSetFont as setCellFont,
  cellSetFill as setCellFill,
  cellSetBorder as setCellBorder,
  cellSetAlignment as setCellAlignment,
  cellSetNumFmt as setCellNumFmt,
  cellSetNote as setCellNote,
  cellSetComment as setCellComment
} from "@excel/core/cell";

// --- streaming row handle operations (operate on a `RowData`) ---
export {
  rowValues,
  rowAddPageBreak as addRowPageBreak,
  rowSetFont as setRowFont,
  rowSetFill as setRowFill,
  rowSetBorder as setRowBorder,
  rowSetAlignment as setRowAlignment
} from "@excel/core/row";
export { rowGetCell as rowCell, rowCommit as commitRow } from "@excel/core/worksheet-core";

// --- streaming types ---
/** A streaming cell handle. */
export type { CellData as CellHandle } from "@excel/core/cell";
/** A streaming row handle. */
export type { RowData as RowHandle } from "@excel/core/row";

/** The worksheet writer handed out by `WorkbookWriter.addWorksheet`. */
export type { WorksheetWriter } from "@excel/stream/worksheet-writer";
/** The worksheet reader yielded by `WorkbookReader.read`. */
export type { WorksheetReader } from "@excel/stream/worksheet-reader";
/** The hyperlink reader yielded by `WorkbookReader.read`. */
export type { HyperlinkReader } from "@excel/stream/hyperlink-reader";

export type {
  WorkbookWriterOptions,
  WorkbookZipOptions,
  ZlibOptions,
  Medium
} from "@excel/stream/workbook-writer.browser";
export type { WorkbookReaderInput } from "@excel/stream/workbook-reader.browser";
export type {
  WorkbookReaderOptions,
  ParseEvent,
  ParseEventType,
  SharedStringEvent,
  SharedStringValue,
  WorksheetReadyEvent,
  HyperlinksEvent
} from "@excel/stream/workbook-reader.browser";
export type {
  WorksheetReaderOptions,
  WorksheetEvent,
  WorksheetEventType,
  WorksheetHyperlink,
  RowEvent,
  HyperlinkEvent
} from "@excel/stream/worksheet-reader";
export type { Hyperlink, HyperlinkReaderOptions } from "@excel/stream/hyperlink-reader";
