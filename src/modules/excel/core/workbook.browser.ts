/**
 * Workbook - Cross-platform Excel Workbook (Browser Version)
 *
 * Base implementation with all platform-agnostic functionality.
 * Node.js version (workbook.ts) extends this with file system support for CSV.
 *
 * Features:
 * - xlsx: File/stream/buffer support (file operations Node.js only)
 * - csv: CSV read/write support (file operations Node.js only)
 * - streaming: createStreamWriter/createStreamReader for large files
 */

// Chart runtime is imported statically. The chart modules depend only on the
// `*-core` data layer (never on this file), so there is no import cycle, and
// the bundler tree-shakes the whole chart tree out of consumer bundles that
// never create or serialise a chart.
import { fillChartCaches, fillChartExCaches } from "@excel/chart/bridge/excel-chart-host";
import { buildChartModel, buildComboChartModel } from "@excel/chart/build/chart-builder";
import { buildChartExModel } from "@excel/chart/build/chart-ex-builder";
import type {
  AddChartExOptions,
  ChartExEntry,
  ChartExModel
} from "@excel/chart/model/chart-ex-types";
import type { AddComboChartOptions, ChartEntry, ChartModel } from "@excel/chart/model/types";
import { resolvePendingChartImages } from "@excel/chart/serialize/chart-images";
import { buildChartColors, buildChartStyle } from "@excel/chart/serialize/chart-sidecar";
import type {
  ChartsheetData,
  AddChartsheetOptions,
  AddPivotChartsheetOptions
} from "@excel/core/chartsheet";
import { chartsheetModel, createChartsheet } from "@excel/core/chartsheet";
import type { DefinedNameModel, SyntaxProbe } from "@excel/core/defined-names";
import {
  createDefinedNames,
  definedNamesModel,
  definedNamesSetModel
} from "@excel/core/defined-names";
import type { OpaqueDrop, OpaquePart } from "@excel/core/opaque-part";
import { withPivotChartSource } from "@excel/core/pivot-chart";
import type { PivotTable } from "@excel/core/pivot-table";
import type { WorkbookData, NamedStyleEntry } from "@excel/core/workbook-core";
import {
  addChartEntry,
  addChartExStructuredEntry,
  getChartEntry,
  getChartExStructuredEntry,
  getWorksheet,
  getWorksheets,
  copyChartSidecars,
  copyChartExSidecars,
  nextChartExNumber,
  nextChartNumber,
  removeChartEntry,
  removeChartExStructuredEntry,
  setChartColors,
  setChartStyle,
  validateSheetName
} from "@excel/core/workbook-core";
import type { Worksheet, WorksheetModel } from "@excel/core/worksheet";
import {
  createWorksheet,
  destroy,
  getSheetModel,
  getSheetName,
  getSheetWorkbook,
  setSheetModel
} from "@excel/core/worksheet";
import type {
  WorkbookReaderOptions,
  WorkbookReaderInput
} from "@excel/stream/workbook-reader.browser";
import { WorkbookReader } from "@excel/stream/workbook-reader.browser";
import type { WorkbookWriterOptions } from "@excel/stream/workbook-writer.browser";
import { WorkbookWriter } from "@excel/stream/workbook-writer.browser";
import type {
  AddWorksheetOptions,
  CalculationProperties,
  Font,
  ThreadedCommentPerson,
  WorkbookProperties,
  WorkbookProtection,
  WorkbookView
} from "@excel/types";
import { synthGuid } from "@excel/utils/guid";
import { buildWorkbookProtection } from "@excel/utils/workbook-protection";
import type { RelationshipModel } from "@excel/xlsx/xform/core/relationship-xform";
import type { ChartsheetModel } from "@excel/xlsx/xform/sheet/chartsheet-xform";
import type { RuntimeValue } from "@formula/runtime/values";
import { BLANK, rvBoolean, rvNumber, rvString } from "@formula/runtime/values";

// =============================================================================
// Internal Types
// =============================================================================

/** Workbook-level media entry (looser than the public `ImageData` input shape). */
export interface WorkbookMedia {
  type: string;
  extension: string;
  filename?: string;
  buffer?: Uint8Array;
  base64?: string;
  name?: string;
  /** External link target — when set, the image is referenced, not embedded. */
  link?: string;
  /**
   * Media index of the SVG companion for this raster image. When set, the
   * picture is written as a raster `a:blip` plus an `asvg:svgBlip` extension
   * referencing the SVG media at this index. Internal bookkeeping only.
   */
  svgMediaId?: number;
}

/** Internal model type for serialization */
export interface WorkbookModel {
  creator?: string;
  lastModifiedBy?: string;
  lastPrinted?: Date;
  created: Date;
  modified: Date;
  properties: Partial<WorkbookProperties>;
  protection?: WorkbookProtectionModel;
  worksheets: WorksheetModel[];
  sheets?: WorksheetModel[];
  definedNames: DefinedNameModel[];
  /**
   * Live `DefinedNames` instance — used by the write-time chartEx
   * transform (`prepareChartExSidecars`) which registers hidden
   * `_xlchart.vN.M` defined names on the fly and needs an object
   * it can mutate in place. The serialised `definedNames` array
   * above is re-materialised from this instance after the
   * transform runs. Optional because the model is also used for
   * input paths that don't carry the live instance.
   */
  definedNamesInstance?: unknown;
  views: WorkbookView[];
  company: string;
  manager: string;
  title: string;
  subject: string;
  keywords: string;
  category: string;
  description: string;
  language?: string;
  revision?: number;
  contentStatus?: string;
  /**
   * Override ContentType for `/xl/workbook.xml`, captured from the source
   * file's `[Content_Types].xml` on read (templates and macro-enabled
   * workbooks declare a different value than a plain .xlsx). Undefined for a
   * freshly created workbook, in which case the writer emits the plain type.
   */
  workbookContentType?: string;
  themes?: unknown;
  media: WorkbookMedia[];
  pivotTables: PivotTable[];
  /** Loaded pivot tables from file - used during reconciliation */
  loadedPivotTables?: PivotTable[];
  calcProperties: Partial<CalculationProperties>;
  /** Default font preserved from the original file for round-trip fidelity */
  defaultFont?: Partial<Font>;
  /** Workbook-level named cell styles (OOXML cellStyles), in definition order. */
  cellStyles?: NamedStyleEntry[];
  /** Chart entries indexed by 1-based chart number */
  chartEntries?: Record<number, ChartEntry>;
  /** Chart rels indexed by chart number — preserved for round-trip */
  chartRels?: Record<number, RelationshipModel[]>;
  /** Chart style XML raw bytes indexed by style number — preserved for round-trip */
  chartStyles?: Record<number, Uint8Array>;
  /** Chart colors XML raw bytes indexed by colors number — preserved for round-trip */
  chartColors?: Record<number, Uint8Array>;
  chartExStyles?: Record<number, Uint8Array>;
  chartExColors?: Record<number, Uint8Array>;
  /** ChartEx raw bytes (Office 2016+ extended charts) indexed by chartEx number */
  chartExEntries?: Record<number, Uint8Array>;
  /** ChartEx rels indexed by chartEx number */
  chartExRels?: Record<number, RelationshipModel[]>;
  /** Structured chartEx entries (loaded or programmatically built) indexed by chartEx number */
  chartExStructuredEntries?: Record<number, ChartExEntry>;
  /** Chartsheets parsed from the XLSX file — preserved for round-trip */
  chartsheets?: ChartsheetModel[];
  /**
   * Office 365 threaded-comment person directory, hydrated from
   * `xl/persons/person.xml` on load and serialised back on save when
   * non-empty. See {@link Workbook.persons}.
   */
  persons?: ThreadedCommentPerson[];
  /**
   * Raw-passthrough slicer parts keyed by zip-relative path. Documonster
   * does not structurally model slicers yet but preserves the bytes on
   * round-trip so dashboards continue to work.
   */
  slicerParts?: Record<string, Uint8Array>;
  slicerCacheParts?: Record<string, Uint8Array>;
  timelineParts?: Record<string, Uint8Array>;
  timelineCacheParts?: Record<string, Uint8Array>;
  /**
   * Package parts this library does not model, preserved verbatim together with
   * their content type and the relationships that reach them.
   *
   * Without this the loader drained unrecognised entries and dropped the bytes,
   * so `read` followed by `write` silently deleted a VBA project, custom
   * document properties, data connections, query tables and printer settings.
   * The macro case was the sharpest: `workbookContentType` *is* round-tripped,
   * so the output kept declaring itself macro-enabled with no macros left in it.
   */
  opaqueParts?: OpaquePart[];
  /**
   * `Default` content-type declarations the preserved parts rely on, keyed by
   * lower-case extension. Separate from {@link OpaquePart.contentType} because a
   * Default is a property of the package, not of one part.
   */
  opaqueContentTypeDefaults?: Record<string, string>;
  /**
   * Preserved parts that were deliberately not written back, and why.
   *
   * Reported rather than discarded because two of the reasons are things a caller
   * may need to act on: a digital signature is removed on any write that
   * re-serialises a modelled part, and a part becomes unreachable when the sheet
   * that referenced it is deleted. Populated on read and topped up at write time,
   * when reachability is finally known.
   */
  opaqueDrops?: OpaqueDrop[];
  /**
   * External workbook references in declaration order. Matches the on-disk
   * `[N]Sheet!Ref` indexing (1-based). Empty or undefined when the workbook
   * has no external references.
   */
  externalLinks?: ExternalLinkModel[];
}

/** Internal model for workbook-level protection (serialized to <workbookProtection>) */
export interface WorkbookProtectionModel {
  lockStructure?: boolean;
  lockWindows?: boolean;
  lockRevision?: boolean;
  workbookPassword?: string;
  revisionsPassword?: string;
  algorithmName?: string;
  hashValue?: string;
  saltValue?: string;
  spinCount?: number;
}

// =============================================================================
// External Workbook Link Types
// =============================================================================

/**
 * Cached values for a single sheet of an external workbook. Keys are the
 * A1-notation cell addresses *in uppercase* (e.g. `"A1"`, `"B12"`). Values
 * are the cached primitives Excel displays when the external file is not
 * currently available — must be JSON primitives: string, number, boolean, or
 * null for an explicitly blank cell.
 */
export type ExternalLinkCachedSheet = Record<string, string | number | boolean | null>;

/**
 * A single external workbook reference. Each entry corresponds to one
 * `xl/externalLinks/externalLink{N}.xml` part in the output file, and to
 * one `<externalReference r:id="...">` entry in `xl/workbook.xml`.
 *
 * The on-disk formula syntax for referring to this workbook is `[N]Sheet!A1`
 * where `N` is the 1-based `index` below.
 */
export interface ExternalLinkModel {
  /**
   * The 1-based index used in `[N]Sheet!A1` formulas. This is the position
   * in the workbook's `<externalReferences>` list (in declaration order).
   * Assigned automatically on read/write; treat as read-only when produced
   * by the library.
   */
  index: number;
  /**
   * The rel Target that will be written into
   * `xl/externalLinks/_rels/externalLink{N}.xml.rels`. For relative paths
   * (which is what users almost always want), pass the bare filename or a
   * path relative to the current workbook: `"测试.xlsx"`, `"data/ref.xlsx"`.
   * Office resolves bare relative paths from the current workbook's
   * directory — *that* is the fix for the "Office goes to the Documents
   * folder" problem with external links.
   *
   * Absolute `file:///` or `http(s)://` URIs are accepted and written
   * through unchanged.
   */
  target: string;
  /**
   * Almost always `"External"`. `"Internal"` is for embedded workbooks
   * (rare) and is preserved on round-trip when present in the source file.
   */
  targetMode: "External" | "Internal";
  /**
   * The relationship id inside `xl/_rels/workbook.xml.rels` pointing to this
   * external link's XML part. Populated automatically on read and
   * re-assigned on write. Callers should leave this undefined.
   */
  rId?: string;
  /**
   * The sheet names exposed by the external workbook, in declaration order.
   * Excel writes one `<sheetName val="..."/>` per entry under
   * `<sheetNames>` inside the externalLink part.
   *
   * At minimum you must declare every sheet that appears in a formula
   * targeting this external workbook, otherwise Excel will fail to link
   * the cached values and show `#REF!`.
   */
  sheetNames: string[];
  /**
   * Cached primitive values per sheet. Key is the *sheet name* (matching an
   * entry in `sheetNames`), value is a map from A1 address to primitive.
   *
   * Cached values are what Excel displays when the referenced external file
   * is not available (e.g. freshly-downloaded workbook on another machine).
   * Writing them turns your file from "opens with errors" into "opens,
   * shows values, offers to update links".
   */
  cachedValues?: Record<string, ExternalLinkCachedSheet>;
}
function isComboChartOptions(chart: AddChartsheetOptions["chart"]): chart is AddComboChartOptions {
  return !!chart && typeof chart === "object" && "groups" in chart;
}

function isChartExOptions(chart: AddChartsheetOptions["chart"]): chart is AddChartExOptions {
  return !!chart && typeof chart === "object" && "type" in chart && isChartExType(chart.type);
}

function isChartExType(type: string): boolean {
  return (
    type === "sunburst" ||
    type === "treemap" ||
    type === "waterfall" ||
    type === "funnel" ||
    type === "histogram" ||
    type === "pareto" ||
    type === "boxWhisker" ||
    type === "regionMap"
  );
}

// =============================================================================
// Workbook Class
// =============================================================================

export function createWorkbook(options?: { formulaSyntaxProbe?: SyntaxProbe }): WorkbookData {
  const wb = {} as WorkbookData;
  wb._tableNames = new Set<string>();

  wb.category = "";
  wb.company = "";
  wb.created = new Date();
  wb.description = "";
  wb.keywords = "";
  wb.manager = "";
  wb.modified = wb.created;
  wb.properties = {};
  wb.calcProperties = {};
  wb._worksheets = [];
  wb.subject = "";
  wb.title = "";
  wb.views = [];
  wb.media = [];
  wb.pivotTables = [];
  wb.externalLinks = [];
  wb._chartEntries = {};
  wb._chartRels = {};
  wb._chartStyles = {};
  wb._chartColors = {};
  wb._chartExStyles = {};
  wb._chartExColors = {};
  wb._chartExEntries = {};
  wb._chartExRels = {};
  wb._chartExStructuredEntries = {};
  wb._chartsheets = [];
  wb._persons = [];
  wb._slicerParts = {};
  wb._slicerCacheParts = {};
  wb._timelineParts = {};
  wb._timelineCacheParts = {};
  wb._opaqueParts = [];
  wb._opaqueContentTypeDefaults = {};
  wb._opaqueDrops = [];
  wb._writerExternalLinkCache = new Map();
  wb._definedNames = createDefinedNames(options?.formulaSyntaxProbe);

  return wb;
}

export function importSheet(wb: WorkbookData, source: Worksheet, name?: string): Worksheet {
  const newWs = addWorksheet(wb, name ?? getSheetName(source));

  // Deep copy via model: the getter serializes ALL worksheet properties and the
  // setter deserializes them, so future properties are automatically included.
  const sourceModel = getSheetModel(source);
  // Remap chart numbers so the source's `chartNumber` / `chartExNumber`
  // references point at entries we actually copy into the target
  // workbook. Build the map here so the rewritten `charts` array and
  // the copied entries use consistent ids.
  const chartMap = new Map<number, number>();
  const chartExMap = new Map<number, number>();
  const sourceWorkbook = getSheetWorkbook(source);
  const differentWorkbook = sourceWorkbook !== wb;
  const sourceCharts = sourceModel.charts ?? [];

  // Worksheet media entries store workbook-level image indexes. A plain model
  // clone is sufficient within one workbook, but across workbooks those indexes
  // point into the SOURCE media registry. Re-register every referenced medium
  // (and an optional SVG companion) in the destination and rewrite the sheet
  // model's imageId; otherwise the writer either drops the image (missing id) or
  // silently renders an unrelated destination image that happens to share it.
  const importedMedia = structuredClone(sourceModel.media ?? []);
  if (differentWorkbook) {
    const mediaMap = new Map<number, number>();
    const copyMedium = (sourceId: number): number | undefined => {
      const existing = mediaMap.get(sourceId);
      if (existing !== undefined) {
        return existing;
      }
      const sourceMedium = sourceWorkbook.media[sourceId];
      if (!sourceMedium) {
        return undefined;
      }
      const cloned = structuredClone(sourceMedium);
      const targetId = wb.media.length;
      // Reserve before following svgMediaId so a malformed self-reference
      // cannot recurse forever.
      mediaMap.set(sourceId, targetId);
      wb.media.push(cloned);
      if (sourceMedium.svgMediaId !== undefined) {
        cloned.svgMediaId = copyMedium(sourceMedium.svgMediaId);
      }
      return targetId;
    };

    for (const medium of importedMedia) {
      const sourceId = Number(medium.imageId);
      if (!Number.isInteger(sourceId) || sourceId < 0) {
        continue;
      }
      const targetId = copyMedium(sourceId);
      if (targetId !== undefined) {
        medium.imageId = String(targetId);
      }
    }
  }
  // `nextChartNumber()` / `nextChartExNumber()` compute `max(existing) + 1`
  // from the entry maps — they do NOT reserve a slot. Calling them in
  // a tight loop without an intervening `addChartEntry` therefore
  // returns the SAME number N times, and the second loop below then
  // overwrites `_chartEntries[dstNum]` repeatedly — only the last
  // cloned entry survives, the others are silently lost. Track the
  // allocator locally so each source chart gets a unique target slot.
  let nextChartAlloc = nextChartNumber(wb);
  let nextChartExAlloc = nextChartExNumber(wb);
  for (const anchor of sourceCharts) {
    if (anchor.chartNumber && anchor.chartNumber > 0 && !chartMap.has(anchor.chartNumber)) {
      chartMap.set(anchor.chartNumber, nextChartAlloc++);
    }
    if (anchor.chartExNumber && anchor.chartExNumber > 0 && !chartExMap.has(anchor.chartExNumber)) {
      chartExMap.set(anchor.chartExNumber, nextChartExAlloc++);
    }
  }
  const remappedCharts = sourceCharts.map(anchor => ({
    ...anchor,
    chartNumber: anchor.chartNumber
      ? (chartMap.get(anchor.chartNumber) ?? anchor.chartNumber)
      : anchor.chartNumber,
    chartExNumber: anchor.chartExNumber
      ? (chartExMap.get(anchor.chartExNumber) ?? anchor.chartExNumber)
      : anchor.chartExNumber
  }));

  // Deep-clone the loaded drawing container and give it a FRESH identity.
  //
  // `getSheetModel`/`setSheetModel` pass `drawing` through by reference, so
  // without this the imported sheet shared the source's `WorksheetModel.drawing`
  // — including its `name` (e.g. "drawing1"). Both sheets then registered a
  // `[Content_Types].xml` Override for the SAME `/xl/drawings/drawingN.xml`
  // part, which is invalid per OPC (duplicate PartName) and trips the built-in
  // validator (issue #189).
  //
  // The writer rebuilds each drawing part's XML from `drawing.anchors` /
  // `drawing.rels` and auto-allocates a fresh, collision-free name for any
  // drawing whose `name` is empty (its allocator is seeded past every name a
  // round-tripped sheet already claims — see WorkSheetXform prepare/prepareModel).
  // So the correct fix is a value copy with the name cleared — not a byte copy
  // of the original part. Chart anchors embedded in the drawing are renumbered
  // with the same `chartMap`/`chartExMap` as the top-level `charts` array so
  // both stay consistent.
  const remapDrawing = (drawing: unknown): unknown => {
    if (!drawing || typeof drawing !== "object") {
      return drawing;
    }
    const cloned = structuredClone(drawing) as {
      name?: string;
      anchors?: Array<{ chartNumber?: number; chartExNumber?: number }>;
    };
    // Clear the name so the writer allocates a fresh, unique one.
    cloned.name = undefined;
    for (const anchor of cloned.anchors ?? []) {
      if (anchor.chartNumber) {
        anchor.chartNumber = chartMap.get(anchor.chartNumber) ?? anchor.chartNumber;
      }
      if (anchor.chartExNumber) {
        anchor.chartExNumber = chartExMap.get(anchor.chartExNumber) ?? anchor.chartExNumber;
      }
    }
    return cloned;
  };

  setSheetModel(newWs, {
    ...sourceModel,
    id: newWs.id,
    name: getSheetName(newWs),
    media: importedMedia,
    charts: remappedCharts,
    drawing: remapDrawing(sourceModel.drawing),
    // getSheetModel()/setSheetModel() pass these through by reference (unlike
    // `charts`, which is rebuilt above), so two sheets would otherwise share
    // the same TableModel / PivotTable / rule / form-control instances —
    // mutating one sheet's copy silently mutated the source. Structured-clone
    // at the import boundary gives the imported sheet independent data. These
    // carry no cross-sheet identity to remap (unlike charts/drawings), so a
    // plain deep copy is the whole fix.
    tables: structuredClone(sourceModel.tables ?? []),
    pivotTables: structuredClone(sourceModel.pivotTables ?? []),
    conditionalFormattings: structuredClone(sourceModel.conditionalFormattings ?? []),
    formControls: structuredClone(sourceModel.formControls ?? [])
  });

  // Copy the actual chart parts + sidecars into the target workbook
  // so the remapped `charts` array references live entries. Without
  // this, `importSheet` left the target with chart anchors but no
  // backing chart XML, producing a broken package on save. We copy
  // both the structured model (via `getChartEntry` / `addChartEntry`
  // — the public API) and all sidecars (`copyChartSidecars` /
  // `copyChartExSidecars`).
  if (chartMap.size > 0 || chartExMap.size > 0) {
    for (const [srcNum, dstNum] of chartMap) {
      const entry = getChartEntry(sourceWorkbook, srcNum);
      if (!entry) {
        continue;
      }
      // Deep-clone the entry with every metadata field preserved —
      // rawData / userShapesXml (byte slices), modelSnapshot and the
      // dirty / preferRawPatch / requireRawPatch writer hints, plus
      // per-entry `rels`. Previously only `model`, `rawData`, and
      // `userShapesXml` were copied, so the cross-workbook import
      // path produced charts where the raw-patch fast path couldn't
      // run and the change-detection snapshot didn't reflect the
      // source entry's load-time state.
      addChartEntry(wb, cloneChartEntry(entry, dstNum));
      if (differentWorkbook) {
        copyChartSidecars(sourceWorkbook, srcNum, dstNum, wb);
      } else {
        copyChartSidecars(wb, srcNum, dstNum);
      }
    }
    for (const [srcNum, dstNum] of chartExMap) {
      const exEntry = getChartExStructuredEntry(sourceWorkbook, srcNum);
      if (exEntry) {
        addChartExStructuredEntry(wb, cloneChartExEntry(exEntry, dstNum));
      } else {
        const rawBytes = sourceWorkbook._chartExEntries?.[srcNum];
        if (rawBytes) {
          wb._chartExEntries[dstNum] = rawBytes.slice();
        }
      }
      if (differentWorkbook) {
        copyChartExSidecars(sourceWorkbook, srcNum, dstNum, wb);
      } else {
        copyChartExSidecars(wb, srcNum, dstNum);
      }
    }
  }

  return newWs;
}

export async function protectWorkbook(
  wb: WorkbookData,
  password?: string,
  options?: Partial<WorkbookProtection>
): Promise<void> {
  wb.protection = await buildWorkbookProtection(password, options);
}

export function unprotectWorkbook(wb: WorkbookData): void {
  wb.protection = undefined;
}

export function addWorksheet(
  wb: WorkbookData,
  name?: string,
  options?: AddWorksheetOptions
): Worksheet {
  const id = getNextId(wb);

  // Allocate `orderNo` from the unified worksheet+chartsheet counter.
  // Looking only at `_worksheets` here (the previous implementation)
  // silently collides when a chartsheet has been added in between:
  // e.g. `addWorksheet("A")` → orderNo 0; `addChartsheet(…)` → 1
  // (via `_nextSheetOrderNo()`); `addWorksheet("B")` → 1 again
  // (because `max(worksheets.orderNo) + 1 = 0 + 1 = 1`), so A and
  // B share an ordinal with the chartsheet. The writer's stable
  // sort then interleaves them non-deterministically, scrambling
  // the user's tab order (`[A, CS, B]` could come out as
  // `[A, B, CS]` or `[A, CS, B]` across runs).
  const orderNo = _nextSheetOrderNo(wb);
  const worksheetOptions = {
    ...options,
    id,
    name,
    orderNo,
    workbook: wb
  };

  const worksheet = createWorksheet(worksheetOptions);

  wb._worksheets[id] = worksheet;
  return worksheet;
}

export function removeWorksheet(wb: WorkbookData, id: number | string): void {
  const worksheet = getWorksheet(wb, id);
  if (worksheet) {
    destroy(worksheet);
  }
}

export function addChartsheet(
  wb: WorkbookData,
  name: string | undefined,
  options: AddChartsheetOptions
): ChartsheetData {
  const sheetName = _validateChartsheetName(wb, name ?? `Chart${wb._chartsheets.length + 1}`);
  const sheetNo = _nextChartsheetNo(wb);
  const id = _nextSheetId(wb);
  // Assign a unified `orderNo` across worksheets and chartsheets so
  // the writer can preserve the author's interleaved tab layout.
  // Without this, workbook-xform `prepare()` sorted by `sheetNo`
  // (file-path number, independent per family) and reordered
  // `[ws1, cs1, ws2]` into `[ws1, ws2, cs1]`.
  const orderNo = _nextSheetOrderNo(wb);
  const chartsheet: ChartsheetModel = {
    sheetNo,
    id,
    name: sheetName,
    orderNo,
    state: options.state ?? "visible",
    tabSelected: options.tabSelected,
    zoomScale: options.zoomScale,
    workbookViewId: options.workbookViewId,
    zoomToFit: options.zoomToFit,
    pageMargins: options.pageMargins,
    pageSetup: options.pageSetup,
    headerFooter: options.headerFooter,
    drawing: { rId: "rId1" }
  };

  if (isChartExOptions(options.chart)) {
    const chartExNumber = nextChartExNumber(wb);
    const model = buildChartExModel(options.chart);
    try {
      fillChartExCaches(model, wb);
    } catch {
      // Cache population is best-effort; never let it break chart creation.
    }
    addChartExStructuredEntry(wb, { chartExNumber, model });
    chartsheet.chartExNumber = chartExNumber;
  } else {
    const chartNumber = nextChartNumber(wb);
    const chartModel = isComboChartOptions(options.chart)
      ? buildComboChartModel(options.chart)
      : buildChartModel(options.chart);
    try {
      fillChartCaches(chartModel, wb);
    } catch {
      // Cache population is best-effort; never let it break chart creation.
    }
    const entry: ChartEntry = { chartNumber, model: chartModel };
    // Resolve programmatic `series.spPr.fill.blip._pendingImage`
    // payloads into workbook media entries and chart rels. The
    // worksheet-embedded `addChart` path does this immediately
    // after `fillChartCaches`; chartsheets ran the same builder
    // output but skipped the image-resolution step entirely, so a
    // picture-fill series authored via `addChartsheet` was
    // registered with its `_pendingImage` stuck on the model and
    // never reached `media/imageN.{ext}` — Excel rendered the
    // series as a transparent fill. Safe to call before
    // `addChartEntry` so the stored entry carries its resolved
    // `entry.rels` from the start.
    try {
      resolvePendingChartImages(entry, wb, chartNumber);
    } catch {
      // Image resolution is best-effort; a broken image payload
      // should never take down chart creation — the series keeps
      // its `pictureOptions`, just without the blipFill.
    }
    addChartEntry(wb, entry);
    _applyChartsheetSidecars(wb, chartNumber, options.chart);
    chartsheet.chartNumber = chartNumber;
  }

  wb._chartsheets.push(chartsheet);
  return createChartsheet(chartsheet, wb);
}

export function addPivotChartsheet(
  wb: WorkbookData,
  name: string | undefined,
  pivotTable: PivotTable,
  options: AddPivotChartsheetOptions
): ChartsheetData {
  return addChartsheet(wb, name, {
    ...options,
    chart: withPivotChartSource(pivotTable, options.chart)
  });
}

export function getChartsheet(
  wb: WorkbookData,
  nameOrIndex: string | number
): ChartsheetData | undefined {
  const model = _getChartsheetModel(wb, nameOrIndex);
  return model ? createChartsheet(model, wb) : undefined;
}

export function removeChartsheet(wb: WorkbookData, nameOrIndex: string | number): boolean {
  const index =
    typeof nameOrIndex === "number"
      ? nameOrIndex
      : wb._chartsheets.findIndex(sheet => sheet.name.toLowerCase() === nameOrIndex.toLowerCase());
  if (index < 0 || index >= wb._chartsheets.length) {
    return false;
  }
  const [removed] = wb._chartsheets.splice(index, 1);
  if (removed.chartNumber) {
    removeChartEntry(wb, removed.chartNumber);
  }
  if (removed.chartExNumber) {
    removeChartExStructuredEntry(wb, removed.chartExNumber);
  }
  return true;
}

function _getChartsheetModel(
  wb: WorkbookData,
  nameOrIndex: string | number
): ChartsheetModel | undefined {
  return typeof nameOrIndex === "number"
    ? wb._chartsheets[nameOrIndex]
    : wb._chartsheets.find(sheet => sheet.name.toLowerCase() === nameOrIndex.toLowerCase());
}

export function renameChartsheet(
  wb: WorkbookData,
  nameOrIndex: string | number,
  name: string
): boolean {
  const model = _getChartsheetModel(wb, nameOrIndex);
  if (!model) {
    return false;
  }
  const currentName = model.name;
  if (currentName === name) {
    return true;
  }
  model.name = "__documonster_pending_chartsheet_rename__";
  try {
    model.name = _validateChartsheetName(wb, name);
    return true;
  } catch (error) {
    model.name = currentName;
    throw error;
  }
}

export function copyChartsheet(
  wb: WorkbookData,
  nameOrIndex: string | number,
  name?: string
): ChartsheetData | undefined {
  const source = _getChartsheetModel(wb, nameOrIndex);
  if (!source) {
    return undefined;
  }
  const cloneName = _validateChartsheetName(wb, name ?? `${source.name} Copy`);
  const clone: ChartsheetModel = {
    ...deepClone(source),
    id: _nextSheetId(wb),
    sheetNo: _nextChartsheetNo(wb),
    // New tab position — the clone goes to the tail of the tab
    // bar, matching Excel's "Duplicate" behaviour. Drop the
    // deep-cloned `orderNo` from the source.
    orderNo: _nextSheetOrderNo(wb),
    name: cloneName,
    drawingName: undefined,
    relationships: source.relationships ? deepClone(source.relationships) : undefined
  };
  if (source.chartNumber) {
    const entry = getChartEntry(wb, source.chartNumber);
    if (entry) {
      const chartNumber = nextChartNumber(wb);
      // Clone the entry with ALL metadata: rawData, modelSnapshot,
      // dirty, preferRawPatch, requireRawPatch, rels (per-entry),
      // userShapesXml. A freshly-created entry carrying only `model`
      // would lose Excel-authored user-shape overlays, the raw-patch
      // fast path, and any per-entry rels that aren't in
      // `_chartRels`. Keeping them in lockstep means a clone of a
      // just-loaded chart matches the source byte-for-byte.
      addChartEntry(wb, cloneChartEntry(entry, chartNumber));
      copyChartSidecars(wb, source.chartNumber, chartNumber);
      clone.chartNumber = chartNumber;
      clone.chartExNumber = undefined;
    }
  } else if (source.chartExNumber) {
    const entry = getChartExStructuredEntry(wb, source.chartExNumber);
    const chartExNumber = nextChartExNumber(wb);
    if (entry) {
      // Same rationale as the classic branch — carry dirty /
      // preferRawPatch / requireRawPatch / rawData / modelSnapshot
      // across the clone so the raw-patch path keeps working on
      // the duplicate.
      addChartExStructuredEntry(wb, cloneChartExEntry(entry, chartExNumber));
    } else if (wb._chartExEntries[source.chartExNumber]) {
      wb._chartExEntries[chartExNumber] = wb._chartExEntries[source.chartExNumber].slice();
    }
    // Copy the chartEx sidecars (authored rels) so the cloned
    // chartsheet's XML references stay valid. Previously a chartEx
    // with `cx14:` / media rels on the source lost every relationship
    // on the clone.
    copyChartExSidecars(wb, source.chartExNumber, chartExNumber);
    clone.chartExNumber = chartExNumber;
    clone.chartNumber = undefined;
  }
  wb._chartsheets.push(clone);
  return createChartsheet(clone, wb);
}

export function replaceChartsheetChart(
  wb: WorkbookData,
  nameOrIndex: string | number,
  chart: AddChartsheetOptions["chart"]
): boolean {
  const wrapper = getChartsheet(wb, nameOrIndex);
  if (!wrapper) {
    return false;
  }
  const model = chartsheetModel(wrapper);
  // Build the replacement first so a malformed options object throws
  // *before* we remove the existing chart entry. Without this, a
  // failed `buildChartExModel` / `buildChartModel` would leave the
  // chartsheet empty (old chart nuked, new chart never registered).
  let newChartExModel: ChartExModel | undefined;
  let newChartModel: ChartModel | undefined;
  if (isChartExOptions(chart)) {
    newChartExModel = buildChartExModel(chart);
  } else if (isComboChartOptions(chart)) {
    newChartModel = buildComboChartModel(chart);
  } else {
    newChartModel = buildChartModel(chart);
  }
  // Remove existing entries only after the new model builds cleanly.
  if (model.chartNumber) {
    removeChartEntry(wb, model.chartNumber);
    model.chartNumber = undefined;
  }
  if (model.chartExNumber) {
    removeChartExStructuredEntry(wb, model.chartExNumber);
    model.chartExNumber = undefined;
  }
  if (newChartExModel) {
    const chartExNumber = nextChartExNumber(wb);
    try {
      fillChartExCaches(newChartExModel, wb);
    } catch {
      // Cache population is best-effort; never let it break chart replacement.
    }
    addChartExStructuredEntry(wb, { chartExNumber, model: newChartExModel });
    model.chartExNumber = chartExNumber;
  } else if (newChartModel) {
    const chartNumber = nextChartNumber(wb);
    try {
      fillChartCaches(newChartModel, wb);
    } catch {
      // Cache population is best-effort; never let it break chart replacement.
    }
    const entry: ChartEntry = { chartNumber, model: newChartModel };
    // Resolve programmatic `series.spPr.fill.blip._pendingImage`
    // payloads — matches the classic `addChart` and `addChartsheet`
    // paths. Previously replacement via `replaceChartsheetChart`
    // silently dropped picture-fill payloads on the floor.
    try {
      resolvePendingChartImages(entry, wb, chartNumber);
    } catch {
      // Image resolution is best-effort; a broken image payload
      // should never take down chart replacement.
    }
    addChartEntry(wb, entry);
    _applyChartsheetSidecars(wb, chartNumber, chart);
    model.chartNumber = chartNumber;
  }
  return true;
}

export function eachSheet(
  wb: WorkbookData,
  callback: (sheet: Worksheet, id: number) => void
): void {
  getWorksheets(wb).forEach(sheet => {
    callback(sheet, sheet.id);
  });
}

export function registerPerson(
  wb: WorkbookData,
  displayName: string,
  userId?: string,
  providerId?: string
): string {
  const existing = wb._persons.find(p => p.displayName === displayName && p.userId === userId);
  if (existing) {
    return existing.id;
  }
  const id = `{${synthGuid()}}`;
  const entry: ThreadedCommentPerson = { id, displayName };
  if (userId !== undefined) {
    entry.userId = userId;
  }
  if (providerId !== undefined) {
    entry.providerId = providerId;
  }
  wb._persons.push(entry);
  return id;
}

export function registerFunction(
  wb: WorkbookData,
  name: string,
  fn: (args: RuntimeValue[]) => RuntimeValue | number | string | boolean | null | undefined,
  options?: { minArity?: number; maxArity?: number; volatile?: boolean }
): void {
  if (!wb.userFunctions) {
    wb.userFunctions = new Map();
  }
  wb.userFunctions.set(name.toUpperCase(), {
    minArity: options?.minArity ?? 0,
    maxArity: options?.maxArity ?? 255,
    volatile: options?.volatile,
    invoke: args => normalizeFunctionResult(fn(args))
  });
}

function normalizeFunctionResult(
  value: RuntimeValue | number | string | boolean | null | undefined
): RuntimeValue {
  if (value === null || value === undefined) {
    return BLANK;
  }
  if (typeof value === "number") {
    return rvNumber(value);
  }
  if (typeof value === "string") {
    return rvString(value);
  }
  if (typeof value === "boolean") {
    return rvBoolean(value);
  }
  return value;
}

export function unregisterFunction(wb: WorkbookData, name: string): boolean {
  return wb.userFunctions?.delete(name.toUpperCase()) ?? false;
}

export function clearThemes(wb: WorkbookData): void {
  // Note: themes are not an exposed feature, meddle at your peril!
  wb._themes = undefined;
}

function _applyChartsheetSidecars(
  wb: WorkbookData,
  chartNumber: number,
  chartOptions: AddChartsheetOptions["chart"]
): void {
  if (isChartExOptions(chartOptions)) {
    return;
  }
  if (!chartOptions.chartStyle && !chartOptions.chartColors) {
    return;
  }
  if (chartOptions.chartStyle) {
    setChartStyle(
      wb,
      chartNumber,
      new TextEncoder().encode(buildChartStyle(chartOptions.chartStyle))
    );
  }
  if (chartOptions.chartColors) {
    setChartColors(
      wb,
      chartNumber,
      new TextEncoder().encode(buildChartColors(chartOptions.chartColors))
    );
  }
}

function _nextChartsheetNo(wb: WorkbookData): number {
  const existing = wb._chartsheets.map(cs => cs.sheetNo).filter(Number.isFinite);
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

function _nextSheetOrderNo(wb: WorkbookData): number {
  let max = -1;
  for (const ws of wb._worksheets) {
    if (ws && typeof ws.orderNo === "number" && ws.orderNo > max) {
      max = ws.orderNo;
    }
  }
  for (const cs of wb._chartsheets) {
    if (typeof cs.orderNo === "number" && cs.orderNo > max) {
      max = cs.orderNo;
    }
  }
  return max + 1;
}

export function _nextSheetId(wb: WorkbookData): number {
  const worksheetIds = getWorksheets(wb).map(ws => ws.id);
  const chartsheetIds = wb._chartsheets.map(cs => cs.id).filter(Number.isFinite);
  const ids = [...worksheetIds, ...chartsheetIds];
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

export function _validateChartsheetName(wb: WorkbookData, name: string): string {
  return validateSheetName(wb, name);
}

export function addExternalLink(
  wb: WorkbookData,
  input: {
    target: string;
    sheetNames?: string[];
    cachedValues?: ExternalLinkModel["cachedValues"];
    targetMode?: ExternalLinkModel["targetMode"];
  }
): ExternalLinkModel {
  const link: ExternalLinkModel = {
    index: wb.externalLinks.length + 1,
    target: input.target,
    targetMode: input.targetMode ?? "External",
    sheetNames: input.sheetNames ? [...input.sheetNames] : [],
    cachedValues: input.cachedValues ? { ...input.cachedValues } : {}
  };
  wb.externalLinks.push(link);
  return link;
}

export function getExternalLink(
  wb: WorkbookData,
  indexOrTarget: number | string
): ExternalLinkModel | undefined {
  if (typeof indexOrTarget === "number") {
    return wb.externalLinks[indexOrTarget - 1];
  }
  const lower = indexOrTarget.toLowerCase();
  return wb.externalLinks.find(link => link.target.toLowerCase() === lower);
}

export function _collectExternalLinksForWrite(wb: WorkbookData): ExternalLinkModel[] {
  const userLower = new Set(wb.externalLinks.map(l => l.target.toLowerCase()));
  const combined: ExternalLinkModel[] = wb.externalLinks.map((link, i) => ({
    ...link,
    index: i + 1,
    sheetNames: [...(link.sheetNames ?? [])],
    cachedValues: { ...(link.cachedValues ?? {}) },
    targetMode: link.targetMode ?? "External"
  }));
  for (const cached of wb._writerExternalLinkCache.values()) {
    if (userLower.has(cached.target.toLowerCase())) {
      // User explicitly added a link with the same target after an
      // auto-discovery pass — prefer the user's definition, drop the
      // cached one.
      continue;
    }
    combined.push({
      ...cached,
      index: combined.length + 1,
      sheetNames: [...cached.sheetNames],
      cachedValues: { ...cached.cachedValues }
    });
  }
  return combined;
}

export function _recordAutoExternalLink(
  wb: WorkbookData,
  target: string,
  sheetName: string
): number {
  const lower = target.toLowerCase();
  // If the user explicitly declared a link with this target, we respect
  // their definition verbatim: no sheetName upserts, no cache entry.
  // Excel needs the user-declared sheetNames to match the refs, and
  // augmenting them on the user's behalf could silently hide a typo.
  const existingUserIdx = wb.externalLinks.findIndex(l => l.target.toLowerCase() === lower);
  if (existingUserIdx !== -1) {
    return existingUserIdx + 1;
  }
  let cached = wb._writerExternalLinkCache.get(lower);
  if (!cached) {
    cached = {
      // Index is provisional — the real on-disk index is recomputed by
      // `_collectExternalLinksForWrite()` at serialisation time.
      index: 0,
      target,
      targetMode: "External",
      sheetNames: [],
      cachedValues: {}
    };
    wb._writerExternalLinkCache.set(lower, cached);
  }
  if (sheetName && !cached.sheetNames.includes(sheetName)) {
    cached.sheetNames.push(sheetName);
  }
  // Recompute final index: user entries first, then cache entries in
  // insertion order. The caller needs the *on-disk* index so that the
  // formula it's rewriting matches the link that will be serialised.
  const userCount = wb.externalLinks.length;
  let cacheIdx = 0;
  for (const key of wb._writerExternalLinkCache.keys()) {
    cacheIdx++;
    if (key === lower) {
      return userCount + cacheIdx;
    }
  }
  // Unreachable — we just inserted.
  return userCount + wb._writerExternalLinkCache.size;
}

export function getDefaultFont(wb: WorkbookData): Partial<Font> | undefined {
  return wb._defaultFont;
}

export function getNextId(wb: WorkbookData): number {
  // Worksheets and chartsheets share a single `sheetId` namespace in
  // `workbook.xml`'s `<sheets>` element (OOXML requires each
  // `sheetId` to be globally unique across both families). Allocating
  // from `_worksheets` alone used to hand out an id already claimed
  // by a chartsheet whenever the author interleaved their calls —
  // e.g. `addWorksheet(×16)` → ids 1-16; `addChartsheet(×2)` → ids
  // 17-18 (via `_nextSheetId()`); then `addWorksheet("X")` walked
  // `_worksheets` slots 1..16, found them full, and returned
  // `_worksheets.length = 17`, colliding with the first chartsheet.
  // Excel rejects the resulting workbook as corrupt. Collect
  // chartsheet ids up front so the search honours the shared pool.
  const chartsheetIds = new Set<number>();
  for (const cs of wb._chartsheets) {
    if (cs && typeof cs.id === "number" && Number.isFinite(cs.id)) {
      chartsheetIds.add(cs.id);
    }
  }
  // Prefer reusing vacated `_worksheets` slots (left as holes by
  // `removeWorksheetEx`) so ids stay stable across delete+add cycles.
  for (let i = 1; i < wb._worksheets.length; i++) {
    if (!wb._worksheets[i] && !chartsheetIds.has(i)) {
      return i;
    }
  }
  // No reusable hole — hand out the next id beyond the current
  // tail, skipping any slots already taken by chartsheets.
  let candidate = wb._worksheets.length || 1;
  while (chartsheetIds.has(candidate)) {
    candidate++;
  }
  return candidate;
}

export function getChartsheets(wb: WorkbookData): ChartsheetData[] {
  return wb._chartsheets.map(model => createChartsheet(model, wb));
}

export function getPersons(wb: WorkbookData): ThreadedCommentPerson[] {
  return wb._persons;
}

export function getWorkbookModel(wb: WorkbookData): WorkbookModel {
  return {
    creator: wb.creator || "Unknown",
    lastModifiedBy: wb.lastModifiedBy || "Unknown",
    lastPrinted: wb.lastPrinted,
    created: wb.created,
    modified: wb.modified,
    properties: wb.properties,
    protection: wb.protection,
    worksheets: getWorksheets(wb).map(worksheet => getSheetModel(worksheet)),
    sheets: getWorksheets(wb)
      .map(ws => getSheetModel(ws))
      .filter(Boolean),
    definedNames: definedNamesModel(wb._definedNames),
    // Live `DefinedNames` instance — required by the write-time
    // chartEx transform `prepareChartExSidecars`, which registers
    // hidden `_xlchart.vN.M` names on the fly and needs an object
    // that can mutate in place. The serialised `definedNames`
    // array above is re-materialised after the transform runs.
    definedNamesInstance: wb._definedNames,
    views: wb.views,
    company: wb.company,
    manager: wb.manager,
    title: wb.title,
    subject: wb.subject,
    keywords: wb.keywords,
    category: wb.category,
    description: wb.description,
    language: wb.language,
    revision: wb.revision,
    contentStatus: wb.contentStatus,
    workbookContentType: wb.workbookContentType,
    themes: wb._themes,
    media: wb.media,
    pivotTables: wb.pivotTables,
    calcProperties: wb.calcProperties,
    defaultFont: wb._defaultFont,
    cellStyles: wb._cellStyles ? [...wb._cellStyles.values()] : undefined,
    externalLinks: wb.externalLinks,
    chartEntries: wb._chartEntries,
    chartRels: wb._chartRels,
    chartStyles: wb._chartStyles,
    chartColors: wb._chartColors,
    chartExStyles: wb._chartExStyles,
    chartExColors: wb._chartExColors,
    chartExEntries: wb._chartExEntries,
    chartExRels: wb._chartExRels,
    chartExStructuredEntries: wb._chartExStructuredEntries,
    chartsheets: wb._chartsheets,
    persons: wb._persons,
    slicerParts: wb._slicerParts,
    slicerCacheParts: wb._slicerCacheParts,
    timelineParts: wb._timelineParts,
    timelineCacheParts: wb._timelineCacheParts,
    opaqueParts: wb._opaqueParts,
    opaqueContentTypeDefaults: wb._opaqueContentTypeDefaults,
    opaqueDrops: wb._opaqueDrops
  };
}

export function setDefaultFont(wb: WorkbookData, font: Partial<Font> | undefined): void {
  wb._defaultFont = font;
}

export function setWorkbookModel(wb: WorkbookData, value: WorkbookModel): void {
  wb.creator = value.creator;
  wb.lastModifiedBy = value.lastModifiedBy;
  wb.lastPrinted = value.lastPrinted;
  wb.created = value.created;
  wb.modified = value.modified;
  wb.company = value.company;
  wb.manager = value.manager;
  wb.title = value.title;
  wb.subject = value.subject;
  wb.keywords = value.keywords;
  wb.category = value.category;
  wb.description = value.description;
  wb.language = value.language;
  wb.revision = value.revision;
  wb.contentStatus = value.contentStatus;
  wb.workbookContentType = value.workbookContentType;

  wb.properties = value.properties;
  wb.protection = value.protection;
  wb.calcProperties = value.calcProperties;
  wb._worksheets = [];
  wb._tableNames.clear();
  value.worksheets.forEach(worksheetModel => {
    const { id, name, state } = worksheetModel;
    // API invariant: `_worksheets` is keyed by a positive integer
    // sheet id. A worksheet model with a missing or non-integer id
    // would be stored under a string pseudo key like `"undefined"`
    // or `"NaN"`, making it unreachable via `getWorksheet(name)`.
    // The xlsx reconciler enforces the same invariant
    // before reaching this point; programmatic callers assigning
    // `model` directly with a malformed payload land here instead.
    if (!Number.isInteger(id) || (id as number) <= 0) {
      return;
    }
    const orderNo = value.sheets && value.sheets.findIndex(ws => ws.id === id);
    const worksheet = (wb._worksheets[id] = createWorksheet({
      id,
      name,
      orderNo: orderNo !== -1 ? orderNo : undefined,
      state,
      workbook: wb
    }));
    setSheetModel(worksheet, worksheetModel);
  });

  definedNamesSetModel(wb._definedNames, value.definedNames);
  wb.views = value.views;
  wb._themes = value.themes;
  wb.media = value.media || [];

  // Handle pivot tables - either newly created or loaded from file
  // Loaded pivot tables come from loadedPivotTables after reconciliation
  wb.pivotTables = value.pivotTables || value.loadedPivotTables || [];

  // Preserve default font for round-trip fidelity
  wb._defaultFont = value.defaultFont;
  // Restore named cell styles for round-trip fidelity
  wb._cellStyles = value.cellStyles
    ? new Map(value.cellStyles.map(cs => [cs.name, cs]))
    : undefined;
  // Restore chart entries
  wb._chartEntries = value.chartEntries || {};
  wb._chartRels = value.chartRels || {};
  wb._chartStyles = value.chartStyles || {};
  wb._chartColors = value.chartColors || {};
  wb._chartExStyles = (value as { chartExStyles?: Record<number, Uint8Array> }).chartExStyles || {};
  wb._chartExColors = (value as { chartExColors?: Record<number, Uint8Array> }).chartExColors || {};
  wb._chartExEntries = value.chartExEntries || {};
  wb._chartExRels = value.chartExRels || {};
  wb._chartExStructuredEntries = value.chartExStructuredEntries || {};
  // Restore chartsheets. Populate each chartsheet's `orderNo` from
  // the position in `value.sheets` (workbook.xml tab order) so the
  // writer's `prepare()` can sort interleaved worksheets +
  // chartsheets back into the author's layout. Matches the
  // equivalent loop above for worksheets.
  wb._chartsheets = value.chartsheets || [];
  if (value.sheets) {
    for (const cs of wb._chartsheets) {
      const idx = value.sheets.findIndex((s: { id?: number }) => s.id === cs.id);
      if (idx !== -1) {
        cs.orderNo = idx;
      }
    }
  }
  // Restore threaded-comment person directory. Always assign a new
  // list so callers editing the previous value don't mutate the
  // newly-loaded workbook by accident.
  wb._persons = value.persons ? [...value.persons] : [];
  // Restore raw-passthrough slicer/timeline parts so dashboards
  // survive round-trip. The maps are stored by reference — loaders
  // and writers treat them as read-only; mutating them between
  // load and save is not supported.
  wb._slicerParts = value.slicerParts ?? {};
  wb._slicerCacheParts = value.slicerCacheParts ?? {};
  wb._timelineParts = value.timelineParts ?? {};
  wb._timelineCacheParts = value.timelineCacheParts ?? {};
  wb._opaqueParts = value.opaqueParts ?? [];
  wb._opaqueContentTypeDefaults = value.opaqueContentTypeDefaults ?? {};
  wb._opaqueDrops = value.opaqueDrops ?? [];
  // Preserve external workbook references (empty array if none)
  wb.externalLinks = value.externalLinks ? [...value.externalLinks] : [];
  // Reset the writer-scoped auto-discovery cache — loading a fresh
  // workbook replaces any accumulated state from previous writes.
  wb._writerExternalLinkCache = new Map();
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Deep-copy a {@link ChartEntry}, preserving every field that affects
 * write-time behaviour — rawData (for the raw-patch fast path),
 * modelSnapshot (change detection), dirty / preferRawPatch /
 * requireRawPatch (writer hints), style / colors (ancillary parts),
 * rels (per-entry relationship bag), and userShapesXml (annotation
 * overlay). The caller supplies the new `chartNumber`; everything
 * else is a structural clone so later mutations on one entry don't
 * leak into the other.
 *
 * `rawData` and `userShapesXml` are `Uint8Array`s — `.slice()` is
 * used instead of `structuredClone` to keep the fast path cheap.
 */
function cloneChartEntry(entry: ChartEntry, chartNumber: number): ChartEntry {
  return {
    chartNumber,
    model: deepClone(entry.model),
    ...(entry.rawData ? { rawData: entry.rawData.slice() } : {}),
    ...(entry.modelSnapshot !== undefined ? { modelSnapshot: entry.modelSnapshot } : {}),
    ...(entry.dirty !== undefined ? { dirty: entry.dirty } : {}),
    ...(entry.preferRawPatch !== undefined ? { preferRawPatch: entry.preferRawPatch } : {}),
    ...(entry.requireRawPatch !== undefined ? { requireRawPatch: entry.requireRawPatch } : {}),
    ...(entry.style ? { style: deepClone(entry.style) } : {}),
    ...(entry.colors ? { colors: deepClone(entry.colors) } : {}),
    ...(entry.rels ? { rels: entry.rels.map(r => ({ ...r })) } : {}),
    ...(entry.userShapesXml ? { userShapesXml: entry.userShapesXml.slice() } : {})
  };
}

/**
 * Deep-copy a {@link ChartExEntry}, preserving the same write-time
 * fields as {@link cloneChartEntry} but for the ChartEx family
 * (structured model + rawData + dirty / preferRawPatch /
 * requireRawPatch + rels).
 */
function cloneChartExEntry(entry: ChartExEntry, chartExNumber: number): ChartExEntry {
  return {
    chartExNumber,
    model: deepClone(entry.model),
    ...(entry.rawData ? { rawData: entry.rawData.slice() } : {}),
    ...(entry.modelSnapshot !== undefined ? { modelSnapshot: entry.modelSnapshot } : {}),
    ...(entry.dirty !== undefined ? { dirty: entry.dirty } : {}),
    ...(entry.preferRawPatch !== undefined ? { preferRawPatch: entry.preferRawPatch } : {}),
    ...(entry.requireRawPatch !== undefined ? { requireRawPatch: entry.requireRawPatch } : {}),
    ...(entry.rels ? { rels: entry.rels.map(r => ({ ...r })) } : {})
  };
}

export type Workbook = WorkbookData;

// Streaming factories (formerly Workbook.createStreamWriter / .createStreamReader
// statics). Free functions so they tree-shake.
export function createStreamWriter(options?: WorkbookWriterOptions): WorkbookWriter {
  return new WorkbookWriter(options);
}

export function createStreamReader(
  input: WorkbookReaderInput,
  options?: WorkbookReaderOptions
): WorkbookReader {
  return new WorkbookReader(input, options);
}

// Re-export the workbook-core container layer so `@excel/workbook` stays the
// canonical import path.
export {
  type WorkbookData,
  type NamedStyleEntry,
  getDefinedNames,
  getChartEntry,
  addChartEntry,
  removeChartEntry,
  nextChartNumber,
  nextChartExNumber,
  addChartExStructuredEntry,
  getChartExStructuredEntry,
  removeChartExStructuredEntry,
  getImage,
  addWorkbookImage,
  validateSheetName,
  removeWorksheetEx,
  setChartStyle,
  setChartColors,
  getWorksheet,
  getWorksheets,
  copyChartSidecars,
  copyChartExSidecars,
  defineCellStyle,
  getCellStyle,
  listCellStyles,
  removeCellStyle,
  useBuiltinCellStyle
} from "@excel/core/workbook-core";
