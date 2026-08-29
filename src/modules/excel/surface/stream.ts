/**
 * `Stream` namespace surface — Node entry.
 *
 * The streaming API is a class-based, incremental, handle-oriented paradigm
 * (distinct from the random-access document model). `Stream` bundles the
 * streaming writer/reader classes together with the handle-level operations
 * used on the `CellData` / `RowData` returned by a streaming worksheet
 * writer, so streaming code never has to reach for the internal flat helpers.
 *
 * `import { Stream } from "documonster/excel"` →
 *   `const wb = new Stream.WorkbookWriter({ filename });`
 *   `const ws = wb.addWorksheet("Sheet1");`
 *   `const row = ws.addRow([1, 2, 3]);`
 *   `Stream.setCellValue(ws.getCell("A1"), 42);`
 *   `Stream.setRowFont(row, { bold: true });`
 *   `Stream.commitRow(row);`
 */
export { WorkbookWriter } from "@excel/stream/workbook-writer";
export { WorkbookReader } from "@excel/stream/workbook-reader";

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
} from "@excel/stream/workbook-writer";
export type { WorkbookReaderInput } from "@excel/stream/workbook-reader";
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
