/**
 * documonster/excel — base exports (platform independent).
 *
 * Shared domain dot-namespaces + error classes for both the Node and browser
 * entries. The two platform-specific namespaces (`Workbook`, `Stream`) are
 * NOT here — each entry (`index.ts` / `index.browser.ts`) re-exports this base
 * and then adds its own platform variant of those two. Mirrors the word
 * module's `index.base.ts` structure.
 *
 *   import { Workbook, Worksheet, Cell, Chart } from "documonster/excel";
 *   const wb = Workbook.create();
 *   const ws = Workbook.addWorksheet(wb, "Sheet1");
 *   Cell.setValue(ws, "A1", 42);
 *   const buf = await Workbook.toBuffer(wb);
 *
 * Each namespace is an ESM namespace re-export over a physical `surface/*.ts`
 * module of flat functions, which tree-shakes per-member on rolldown / rspack.
 */

// --- Domain namespaces (platform-independent) ---
export * as Worksheet from "@excel/surface/worksheet";
export * as Cell from "@excel/surface/cell";
export * as Row from "@excel/surface/row";
export * as Column from "@excel/surface/column";
export * as Range from "@excel/surface/range";
export * as Chart from "@excel/surface/chart";
export * as Table from "@excel/surface/table";
export * as Image from "@excel/surface/image";
export * as Pivot from "@excel/surface/pivot";
export * as Sparkline from "@excel/surface/sparkline";
export * as Form from "@excel/surface/form";
export * as Chartsheet from "@excel/surface/chartsheet";
export * as DataValidation from "@excel/surface/data-validation";
export * as DefinedNames from "@excel/surface/defined-names";
export * as Note from "@excel/surface/note";
export * as Address from "@excel/surface/address";
export * as Anchor from "@excel/surface/anchor";
export * as Watermark from "@excel/surface/watermark";
export * as HeaderFooterImage from "@excel/surface/header-footer-image";
export * as Format from "@excel/surface/format";

// --- Errors (extend BaseError; consistent with every other module's entry) ---
export {
  ExcelError,
  isExcelError,
  WorksheetNameError,
  InvalidAddressError,
  ColumnOutOfBoundsError,
  RowOutOfBoundsError,
  MergeConflictError,
  InvalidValueTypeError,
  ExcelNotSupportedError,
  ExcelFileError,
  ExcelStreamStateError,
  ExcelDownloadError,
  PivotTableError,
  ChartOptionsError,
  TableError,
  ImageError,
  MaxItemsExceededError
} from "@excel/errors";
