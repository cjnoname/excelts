/**
 * `Worksheet` namespace surface — sheet-level structure operations.
 *
 * `import { Worksheet } from "documonster/excel"` → `Worksheet.merge(ws, "A1:B2")`,
 * `Worksheet.addRow(ws, [...])`, `Worksheet.eachRow(ws, cb)`, …
 *
 * Cell / Row / Column / Chart / Table / Image / Pivot operations live in their
 * own namespaces, not here.
 */
export {
  mergeCells as merge,
  mergeCellsWithoutStyle as mergeWithoutStyle,
  unMergeCells as unmerge,
  spliceRows,
  spliceColumns,
  insertRow,
  insertRows,
  duplicateRow,
  fillFormula,
  protect,
  unprotect,
  verifyPassword,
  destroy,
  autoFitColumn,
  autoFitColumns,
  autoFitRow,
  autoFitRows,
  addConditionalFormatting,
  removeConditionalFormatting,
  addJSON as addJson,
  toJSON as toJson,
  addAOA as addAoa,
  toAOA as toAoa,
  getSheetDimensions as dimensions,
  getColumnCount as columnCount,
  getActualColumnCount as actualColumnCount,
  getRowCount as rowCount,
  getActualRowCount as actualRowCount,
  getHasMerges as hasMerges,
  getMergedRegions as mergedRegions,
  getSheetModel as getModel,
  setSheetModel as setModel,
  setSheetName as setName,
  getSheetName as getName,
  setColumns,
  getColumns as columns,
  getColumnDefinitions as columnDefinitions,
  getLastColumn as lastColumn,
  getLastRow as lastRow
} from "@excel/core/worksheet";

export {
  addRow,
  addRows,
  getRow,
  getRows,
  findRow,
  findRows,
  eachRow,
  getSheetValues as getValues
} from "@excel/core/worksheet-core";

/** A worksheet handle (opaque to consumers). */
export type { WorksheetData as Handle } from "@excel/core/worksheet-core";
