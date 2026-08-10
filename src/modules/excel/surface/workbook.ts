/**
 * `Workbook` namespace surface — Node entry.
 *
 * `import { Workbook } from "documonster/excel"` → `Workbook.create()`,
 * `Workbook.addWorksheet(wb, name)`, `Workbook.toBuffer(wb)`, `Workbook.read(wb, bytes)`,
 * `Workbook.readFile(wb, path)`, `Workbook.writeFile(wb, path)`, …
 *
 * Re-exports the workbook management functions (de-prefixed) plus the
 * Node xlsx IO (includes file-path `readFile` / `writeFile`).
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
  setWorkbookModel as setModel
} from "@excel/core/workbook.browser";

export {
  toBuffer,
  toStream,
  read,
  readFile,
  writeFile,
  readStream,
  writeStream,
  createStreamWriter,
  createStreamReader,
  getXlsxIo
} from "@excel/core/workbook";
export type { XlsxReadable, XlsxWritable, XlsxStreamOptions } from "@excel/core/workbook";

/** A workbook handle (opaque to consumers). */
export type { WorkbookData as Handle } from "@excel/core/workbook-core";
