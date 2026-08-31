/**
 * `Workbook` namespace surface — browser entry.
 *
 * Same as the Node `surface/workbook.ts` but IO comes from
 * `@excel/xlsx-io` (cross-platform `toBuffer` / `read` / streaming only — no
 * Node file-path `readFile` / `writeFile`). The `.browser` same-name swap
 * selects the browser xlsx binding.
 */
export {
  createWorkbook as create,
  addWorksheet,
  getWorksheet,
  getWorksheets,
  removeWorksheet,
  addChartsheet,
  addPivotChartsheet,
  getChartsheet,
  getChartsheets,
  removeChartsheet,
  renameChartsheet,
  copyChartsheet,
  replaceChartsheetChart,
  getDefinedNames,
  eachSheet,
  importSheet,
  protectWorkbook as protect,
  unprotectWorkbook as unprotect,
  addExternalLink,
  getExternalLink,
  registerPerson,
  registerFunction,
  unregisterFunction,
  defineCellStyle,
  getCellStyle,
  listCellStyles,
  removeCellStyle,
  useBuiltinCellStyle,
  getWorkbookModel as getModel,
  setWorkbookModel as setModel,
  createStreamWriter,
  createStreamReader
} from "@excel/core/workbook.browser";

export {
  toBuffer,
  toStream,
  read,
  readWithDiagnostics,
  readStream,
  writeStream,
  getXlsxIo
} from "@excel/core/xlsx-io";
export type { XlsxReadable, XlsxWritable, XlsxStreamOptions } from "@excel/core/xlsx-io";

/** A workbook handle (opaque to consumers). */
export type { WorkbookData as Handle } from "@excel/core/workbook-core";
