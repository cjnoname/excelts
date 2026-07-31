/**
 * `Chartsheet` namespace surface — operations on a chartsheet handle.
 *
 * `import { Chartsheet } from "documonster/excel"` →
 *   `Chartsheet.name(cs)`, `Chartsheet.chart(cs)`, `Chartsheet.model(cs)`.
 *
 * Chartsheet *creation / management* (`addChartsheet`, `getChartsheet`,
 * `removeChartsheet`) is workbook-centric and lives on the `Workbook`
 * namespace; this namespace holds the per-handle accessors.
 */
export {
  createChartsheet as create,
  chartsheetId as id,
  chartsheetSheetNo as sheetNo,
  chartsheetName as name,
  chartsheetSetName as setName,
  chartsheetState as state,
  chartsheetSetState as setState,
  chartsheetChartNumber as chartNumber,
  chartsheetChartExNumber as chartExNumber,
  chartsheetChartModel as chartModel,
  chartsheetChartExModel as chartExModel,
  chartsheetChart as chart,
  chartsheetIsChartEx as isChartEx,
  chartsheetModel as model,
  chartsheetPageMargins as pageMargins,
  chartsheetSetPageMargins as setPageMargins,
  chartsheetPageSetup as pageSetup,
  chartsheetSetPageSetup as setPageSetup,
  chartsheetHeaderFooter as headerFooter,
  chartsheetSetHeaderFooter as setHeaderFooter,
  chartsheetTabSelected as tabSelected,
  chartsheetSetTabSelected as setTabSelected,
  chartsheetZoomScale as zoomScale,
  chartsheetSetZoomScale as setZoomScale,
  chartsheetWorkbookViewId as workbookViewId,
  chartsheetSetWorkbookViewId as setWorkbookViewId,
  chartsheetZoomToFit as zoomToFit,
  chartsheetSetZoomToFit as setZoomToFit
} from "@excel/core/chartsheet";

/** A chartsheet handle. */
export type { ChartsheetData as Handle } from "@excel/core/chartsheet";
