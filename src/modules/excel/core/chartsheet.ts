import { createChart } from "@excel/chart/chart-handle";
import type { AddChartExOptions, ChartExModel } from "@excel/chart/model/chart-ex-types";
import type { AddChartOptions, AddComboChartOptions, ChartModel } from "@excel/chart/model/types";
import {
  getChartEntry,
  getChartExStructuredEntry,
  validateSheetName
} from "@excel/core/workbook-core";
import type { WorkbookData } from "@excel/core/workbook-core";
import type { ChartHandle, WorksheetData } from "@excel/core/worksheet-core";
import type { HeaderFooter } from "@excel/types";
import type { ChartsheetModel } from "@excel/xlsx/xform/sheet/chartsheet-xform";

export type { ChartsheetModel } from "@excel/xlsx/xform/sheet/chartsheet-xform";

/**
 * Nominal anchor range for the full-sheet chart in a chartsheet.
 * Chartsheet charts fill the entire sheet viewport; the anchor value is
 * never used for positioning but is required by the Chart constructor to
 * initialise its internal two-cell-anchor model.
 */
const CHARTSHEET_ANCHOR_RANGE = "A1:K15";

export interface ChartsheetViewOptions {
  /** Whether the chartsheet tab is selected in the workbook view. */
  tabSelected?: boolean;
  /** Zoom scale percentage. */
  zoomScale?: number;
  /**
   * 0-based index into the workbook's `<bookViews>` list that this
   * chartsheet view is bound to. Defaults to 0 (the primary view).
   */
  workbookViewId?: number;
  /**
   * When true the chartsheet scales to fill the window. Matches the
   * OOXML `<sheetView zoomToFit="1"/>` attribute.
   */
  zoomToFit?: boolean;
}

export interface ChartsheetOptions extends ChartsheetViewOptions {
  /** Sheet visibility state. */
  state?: "visible" | "hidden" | "veryHidden";
  /** Page margins for the chartsheet. */
  pageMargins?: ChartsheetModel["pageMargins"];
  /** Page setup for the chartsheet (CT_CsPageSetup). */
  pageSetup?: ChartsheetModel["pageSetup"];
  /** Printable headers and footers. */
  headerFooter?: Partial<HeaderFooter>;
}

export interface AddChartsheetOptions extends ChartsheetOptions {
  /** Chart to place on the chartsheet. */
  chart: AddChartOptions | AddComboChartOptions | AddChartExOptions;
}

export interface AddPivotChartsheetOptions extends ChartsheetOptions {
  /** Classic chart or combo chart to place on the chartsheet as a pivot chart. */
  chart: AddChartOptions | AddComboChartOptions;
}

/**
 * Minimal `Worksheet`-shaped proxy used exclusively to back the `Chart`
 * instance returned from {@link chartsheetChart}.
 *
 * A chartsheet hosts a single chart without a surrounding grid. `Chart`
 * assumes it lives inside a `Worksheet`, so this proxy forwards the
 * `workbook`/`_workbook` pointers and reports a synthetic `id`/`name`, while
 * every grid-centric method throws a descriptive error so accidental reach
 * through fails loudly instead of silently corrupting state.
 *
 * This is an internal interface-adapter (not a domain model): it carries
 * runtime methods because `Chart` calls them, so it is built by a factory
 * returning a closure object rather than a plain record.
 */
interface ChartsheetChartHost {
  readonly id: number;
  readonly name: string;
  readonly workbook: WorkbookData;
  readonly _workbook: WorkbookData;
  getRow(rowNumber: number): never;
  addRow(): never;
  addRows(): never;
  getColumn(colNumber: number): never;
  getCell(): never;
  addTable(): never;
  getTables(): never;
}

function createChartsheetChartHost(
  workbook: WorkbookData,
  chartsheetId: number,
  chartsheetName: string
): ChartsheetChartHost {
  const unsupported = (method: string): never => {
    throw new Error(
      `${method}() is not supported on a Chart attached to a chartsheet. ` +
        `Use the Chartsheet APIs (Chartsheet.chartModel, Chartsheet.replaceChart, …) instead.`
    );
  };
  return {
    id: chartsheetId,
    name: chartsheetName,
    workbook,
    _workbook: workbook,
    getRow: (_rowNumber: number) => unsupported("Worksheet.getRow"),
    addRow: () => unsupported("Worksheet.addRow"),
    addRows: () => unsupported("Worksheet.addRows"),
    getColumn: (_colNumber: number) => unsupported("Worksheet.getColumn"),
    getCell: () => unsupported("Worksheet.getCell"),
    addTable: () => unsupported("Worksheet.addTable"),
    getTables: () => unsupported("Worksheet.getTables")
  };
}

// ============================================================================
// Chartsheet — de-classed domain model (data record + flat helpers)
// ============================================================================

/**
 * Plain-data chartsheet (de-classed domain model). Holds the
 * {@link ChartsheetModel} and an optional owning workbook; all former
 * getters/setters are flat `chartsheet*` helpers.
 */
export interface ChartsheetData {
  _model: ChartsheetModel;
  _workbook?: WorkbookData;
}

/** Create a chartsheet record from a model + optional owning workbook. */
export function createChartsheet(model: ChartsheetModel, workbook?: WorkbookData): ChartsheetData {
  return { _model: model, _workbook: workbook };
}

export function chartsheetId(cs: ChartsheetData): number {
  return cs._model.id;
}

export function chartsheetSheetNo(cs: ChartsheetData): number {
  return cs._model.sheetNo;
}

export function chartsheetName(cs: ChartsheetData): string {
  return cs._model.name;
}

export function chartsheetSetName(cs: ChartsheetData, value: string): void {
  // Go through the workbook's unified validator so a chartsheet can never
  // silently land on a name that collides with a worksheet (or another
  // chartsheet), includes illegal characters, or exceeds Excel's 31-char limit.
  if (cs._workbook) {
    cs._model.name = validateSheetName(cs._workbook, value, cs._model);
  } else {
    cs._model.name = value;
  }
}

export function chartsheetState(cs: ChartsheetData): ChartsheetModel["state"] {
  return cs._model.state;
}

export function chartsheetSetState(cs: ChartsheetData, value: ChartsheetModel["state"]): void {
  cs._model.state = value;
}

export function chartsheetChartNumber(cs: ChartsheetData): number | undefined {
  return cs._model.chartNumber;
}

export function chartsheetChartExNumber(cs: ChartsheetData): number | undefined {
  return cs._model.chartExNumber;
}

export function chartsheetChartModel(cs: ChartsheetData): ChartModel | undefined {
  return cs._model.chartNumber
    ? (cs._workbook ? getChartEntry(cs._workbook, cs._model.chartNumber) : undefined)?.model
    : undefined;
}

export function chartsheetChartExModel(cs: ChartsheetData): ChartExModel | undefined {
  return cs._model.chartExNumber
    ? (cs._workbook ? getChartExStructuredEntry(cs._workbook, cs._model.chartExNumber) : undefined)
        ?.model
    : undefined;
}

/**
 * Return the `Chart` wrapper for this chartsheet's single chart.
 *
 * The wrapper's `.worksheet` field is a {@link ChartsheetChartHost} rather
 * than a real `Worksheet` — grid operations on it will throw a descriptive
 * error. For anything grid-related, use {@link chartsheetChartModel} /
 * {@link chartsheetChartExModel} directly.
 */
export function chartsheetChart(cs: ChartsheetData): ChartHandle | undefined {
  if (!cs._workbook || (!cs._model.chartNumber && !cs._model.chartExNumber)) {
    return undefined;
  }
  const host = createChartsheetChartHost(cs._workbook, cs._model.id, cs._model.name);
  // `createChart` types its first argument as `WorksheetData`, but internally
  // it only touches `worksheet._workbook`, `worksheet.id`, and `worksheet.name`
  // (plus anchor helpers the host stubs). Casting is safe because the host
  // implements that exact contract and rejects anything else.
  return createChart(
    host as unknown as WorksheetData,
    { chartNumber: cs._model.chartNumber, chartExNumber: cs._model.chartExNumber },
    CHARTSHEET_ANCHOR_RANGE
  );
}

export function chartsheetIsChartEx(cs: ChartsheetData): boolean {
  return !!cs._model.chartExNumber;
}

export function chartsheetModel(cs: ChartsheetData): ChartsheetModel {
  return cs._model;
}

export function chartsheetPageMargins(cs: ChartsheetData): ChartsheetModel["pageMargins"] {
  return cs._model.pageMargins;
}

export function chartsheetSetPageMargins(
  cs: ChartsheetData,
  value: ChartsheetModel["pageMargins"]
): void {
  cs._model.pageMargins = value;
}

export function chartsheetPageSetup(cs: ChartsheetData): ChartsheetModel["pageSetup"] {
  return cs._model.pageSetup;
}

export function chartsheetSetPageSetup(
  cs: ChartsheetData,
  value: ChartsheetModel["pageSetup"]
): void {
  cs._model.pageSetup = value;
}

export function chartsheetHeaderFooter(cs: ChartsheetData): ChartsheetModel["headerFooter"] {
  return cs._model.headerFooter;
}

export function chartsheetSetHeaderFooter(
  cs: ChartsheetData,
  value: ChartsheetModel["headerFooter"]
): void {
  cs._model.headerFooter = value;
}

export function chartsheetTabSelected(cs: ChartsheetData): boolean | undefined {
  return cs._model.tabSelected;
}

export function chartsheetSetTabSelected(cs: ChartsheetData, value: boolean | undefined): void {
  cs._model.tabSelected = value;
}

export function chartsheetZoomScale(cs: ChartsheetData): number | undefined {
  return cs._model.zoomScale;
}

export function chartsheetSetZoomScale(cs: ChartsheetData, value: number | undefined): void {
  cs._model.zoomScale = value;
}

export function chartsheetWorkbookViewId(cs: ChartsheetData): number | undefined {
  return cs._model.workbookViewId;
}

export function chartsheetSetWorkbookViewId(cs: ChartsheetData, value: number | undefined): void {
  cs._model.workbookViewId = value;
}

export function chartsheetZoomToFit(cs: ChartsheetData): boolean | undefined {
  return cs._model.zoomToFit;
}

export function chartsheetSetZoomToFit(cs: ChartsheetData, value: boolean | undefined): void {
  cs._model.zoomToFit = value;
}
