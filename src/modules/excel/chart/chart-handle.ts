/**
 * Chart - High-level chart object for worksheet embedding.
 *
 * Similar to Image, a Chart belongs to a Worksheet and carries the
 * structural data needed for both the DrawingML anchor and the
 * standalone chart XML part.
 */

import {
  fillChartCaches,
  fillChartExCaches,
  fillChartExCachesForRendering
} from "@excel/chart/bridge/excel-chart-host";
import {
  applyChartSeriesOptionsPatch,
  buildChartModel,
  buildChartSeriesForType
} from "@excel/chart/build/chart-builder";
import type { ChartExModel } from "@excel/chart/model/chart-ex-types";
import type {
  AddChartOptions,
  AddChartRange,
  ChartAnchorModel,
  ChartEntry,
  ChartModel,
  ChartTitle,
  ChartTypeGroup,
  ChartAxis,
  ChartLegend,
  PlotArea,
  ShapeProperties,
  ChartRichText,
  ChartTextProperties,
  SeriesBase,
  AddChartSeriesOptions
} from "@excel/chart/model/types";
import { resolvePendingChartImages } from "@excel/chart/serialize/chart-images";
import { buildChartColors, buildChartStyle } from "@excel/chart/serialize/chart-sidecar";
import { parseTxPr } from "@excel/chart/shared/shape-properties";
import type { AnchorData, AnchorModel } from "@excel/core/anchor";
import { anchorCreate, anchorModel } from "@excel/core/anchor";
import {
  addChartEntry,
  addChartExStructuredEntry,
  copyChartExSidecars,
  copyChartSidecars,
  getChartEntry,
  getChartExStructuredEntry,
  nextChartExNumber,
  nextChartNumber,
  setChartColors,
  setChartStyle
} from "@excel/core/workbook-core";
import type { ChartAnchorRange, ChartHandle, WorksheetData } from "@excel/core/worksheet-core";
import { getSheetWorkbook } from "@excel/core/worksheet-core";
import { ChartOptionsError } from "@excel/errors";
import { colCache } from "@excel/utils/col-cache";
import { RelType } from "@excel/xlsx/rel-type";

/**
 * Default chart extent when a caller passes a single-cell address. Matches
 * Excel's behaviour on a fresh chart insertion (roughly 10 columns × 15
 * rows). Shared between the initial anchor resolution and {@link Chart._cloneRange}
 * so the two paths cannot drift.
 */
const DEFAULT_CHART_WIDTH_COLS = 10;
const DEFAULT_CHART_HEIGHT_ROWS = 15;

// Pre-compiled regexes for _extractTextFromRawTx.
// NOTE: These patterns are consumed via `String.prototype.matchAll`, which
// returns a fresh iterator per call. They are intentionally NOT used with
// `RegExp.prototype.exec` + shared `lastIndex`, which would interleave state
// across concurrent callers (multiple titles extracted on the same chart in
// parallel promise chains).
//
// The `<a:t>` open tag may carry attributes — notably `xml:space="preserve"`
// when the run contains leading / trailing or internal whitespace. The
// original pattern (`<a:t>…`) missed those, causing the text extractor
// to skip every preserved-whitespace run. Allow a `>` or any attribute
// list (`[^>]*>`) to close the open tag.
const RAW_TX_AT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const RAW_TX_CV_RE = /<c:v(?:\s[^>]*)?>([\s\S]*?)<\/c:v>/g;

/**
 * A chart embedded in a worksheet.
 *
 * Charts come in two flavours:
 *
 * - **Classic** (`chartNumber` set): a fully-parsed `c:chart` with a
 *   {@link ChartModel}. All public accessors (`chartModel`,
 *   `chartTypes`, `axes`, series mutators, `style`, `mutate`, …) are
 *   backed by the structured model.
 *
 * - **ChartEx** (`chartExNumber` set): Office 2016+ `cx:chart`. The
 *   structured model (`chartExModel`) is populated; a parallel
 *   `rawXml` buffer is kept so byte-for-byte round-trip is the default
 *   when no mutation happens. The high-level accessors that make
 *   sense on both flavours (`title`, `legend`, `spPr`, `toSVG`,
 *   `toPNG`, `unknownElements`) work uniformly. ChartTypeGroup-level
 *   APIs (`chartTypes`, `axes`, `plotArea`, `getAxis`, `categoryAxis`,
 *   `valueAxis`, `addSeries`, `removeSeries`, `getSeries`,
 *   `updateSeries`, `addSeriesFromOptions`, `getSeriesCount`, `mutate`,
 *   `setStyle`) are classic-only — ChartEx has its own topology that
 *   doesn't map cleanly onto the classic group/series abstraction;
 *   use {@link Chart.mutateChartEx} for ChartEx mutations.
 */
// ============================================================================
// Chart — de-classed domain model (data record + flat helpers)
// ============================================================================

export function createChart(
  worksheet: WorksheetData,
  ids: { chartNumber?: number; chartExNumber?: number },
  range: AddChartRange | ChartAnchorModel["range"]
): ChartHandle {
  const c: ChartHandle = {
    worksheet,
    chartNumber: ids.chartNumber ?? 0,
    chartExNumber: ids.chartExNumber ?? 0,
    range: undefined as never
  };
  c.range = chartParseRange(worksheet, range);
  return c;
}

// ===========================================================================
// Chart registration — attach a built model to a worksheet.
//
// These live in the chart module (not `worksheet.ts`) so the dependency
// flows one way: `worksheet → chart → *-core`. `worksheet.ts`'s public
// `addChart`/`addLineChart`/… call these directly; no host registry needed.
// ===========================================================================

/**
 * Register a classic chart model on a worksheet: populate caches, resolve
 * staged picture-fill images, store the entry, apply style/colours sidecars,
 * and append a {@link ChartHandle}. Returns the 1-based chart number.
 */
export function registerChart(
  ws: WorksheetData,
  chartModel: ChartModel,
  range: AddChartRange,
  options?: Pick<AddChartOptions, "chartStyle" | "chartColors">
): number {
  const chartNumber = nextChartNumber(ws._workbook);
  // Auto-populate caches so headless consumers see non-empty charts.
  // Excel itself will recompute on open; this is a best-effort enrichment.
  // Pass `ws` as context worksheet so sheet-scoped defined names on this
  // sheet take precedence over workbook-scoped names of the same bare name.
  try {
    fillChartCaches(chartModel, ws._workbook, ws);
  } catch {
    // Cache population is best-effort; never let it break chart creation.
  }
  const entry: ChartEntry = { chartNumber, model: chartModel };
  // Resolve any staged `pictureFill.image` payloads into real workbook
  // media entries + chart relationships. Safe to call before `addChartEntry`
  // so the entry we store already carries the final `entry.rels` array.
  try {
    resolvePendingChartImages(entry, ws._workbook, chartNumber);
  } catch {
    // Image resolution is best-effort; a broken image payload should never
    // take down chart creation — the series keeps its `pictureOptions`.
  }
  addChartEntry(ws._workbook, entry);
  applyChartSidecars(ws, chartNumber, options);
  const chartInstance = createChart(ws, { chartNumber }, range);
  ws._charts.push(chartInstance);
  return chartNumber;
}

/** Register a ChartEx (Office 2016+ extended) model on a worksheet. */
export function registerChartEx(
  ws: WorksheetData,
  model: ChartExModel,
  range: AddChartRange
): number {
  const chartExNumber = nextChartExNumber(ws._workbook);
  try {
    fillChartExCaches(model, ws._workbook, ws);
  } catch {
    // Cache population is best-effort; never let it break chart creation.
  }
  addChartExStructuredEntry(ws._workbook, { chartExNumber, model });
  const chartInstance = createChart(ws, { chartExNumber }, range);
  ws._charts.push(chartInstance);
  return chartExNumber;
}

/** Apply optional chartStyle/chartColors sidecars to a registered chart. */
export function applyChartSidecars(
  ws: WorksheetData,
  chartNumber: number,
  options?: Pick<AddChartOptions, "chartStyle" | "chartColors">
): void {
  if (!options?.chartStyle && !options?.chartColors) {
    return;
  }
  if (options?.chartStyle) {
    setChartStyle(
      ws._workbook,
      chartNumber,
      new TextEncoder().encode(buildChartStyle(options.chartStyle))
    );
  }
  if (options?.chartColors) {
    setChartColors(
      ws._workbook,
      chartNumber,
      new TextEncoder().encode(buildChartColors(options.chartColors))
    );
  }
}

/** Whether this is an Office 2016+ extended chart (cx:chart) */
export function chartIsChartEx(c: ChartHandle): boolean {
  return c.chartExNumber > 0;
}

function chartParseRange(
  worksheet: WorksheetData,
  range: AddChartRange | ChartAnchorModel["range"]
): ChartAnchorRange {
  if (typeof range === "string") {
    const decoded = colCache.decode(range);
    if ("top" in decoded) {
      return {
        tl: anchorCreate(worksheet, { col: decoded.left, row: decoded.top }, -1),
        br: anchorCreate(worksheet, { col: decoded.right, row: decoded.bottom }, 0),
        editAs: "twoCell"
      };
    }
    // Single cell — default to DEFAULT_CHART_WIDTH_COLS x DEFAULT_CHART_HEIGHT_ROWS.
    const addr = colCache.decodeAddress(range);
    return {
      tl: anchorCreate(worksheet, { col: addr.col, row: addr.row }, -1),
      br: anchorCreate(
        worksheet,
        {
          col: addr.col + DEFAULT_CHART_WIDTH_COLS,
          row: addr.row + DEFAULT_CHART_HEIGHT_ROWS
        },
        0
      ),
      editAs: "twoCell"
    };
  }

  const parseAnchor = (v: { col: number; row: number } | AnchorModel | string): AnchorData => {
    if (typeof v === "string") {
      return anchorCreate(worksheet, v, -1);
    }
    return anchorCreate(worksheet, v, 0);
  };

  // Absolute anchor: { pos, ext }. `ext` is mandatory — without it
  // the drawing layer has no extent to emit and the writer would
  // produce `<xdr:ext cx="undefined" cy="undefined"/>`. Reject
  // early so callers see a clear error at the assignment site
  // rather than an opaque serialization failure.
  if ("pos" in range && range.pos !== undefined) {
    if (!range.ext) {
      throw new ChartOptionsError(
        "Chart range with `pos` requires `ext` (absolute anchor needs an explicit EMU extent)."
      );
    }
    return {
      // Absolute anchors have no meaningful "tl" cell, but the drawing layer
      // still requires one — default to (0, 0) with the provided offsets.
      tl: anchorCreate(worksheet, { col: 0, row: 0 }, 0),
      pos: range.pos,
      ext: range.ext,
      editAs: range.editAs ?? "absolute"
    };
  }

  // One-cell anchor: { tl, ext } with no bottom-right. We key on
  // `range.br === undefined` (not `"br" in range`) so a caller that
  // passes `{ tl, ext, br: undefined }` still lands here instead of
  // falling through to the two-cell branch, which would then call
  // `parseAnchor(undefined)` and throw from inside the Anchor
  // constructor.
  if (
    "tl" in range &&
    "ext" in range &&
    range.ext !== undefined &&
    (!("br" in range) || (range as { br?: unknown }).br === undefined)
  ) {
    return {
      tl: parseAnchor(range.tl),
      ext: range.ext,
      editAs: range.editAs ?? "oneCell"
    };
  }

  // Two-cell anchor: { tl, br }
  const twoCell = range as {
    tl: { col: number; row: number } | AnchorModel | string;
    br: { col: number; row: number } | AnchorModel | string;
    editAs?: string;
  };
  return {
    tl: parseAnchor(twoCell.tl),
    br: parseAnchor(twoCell.br),
    editAs: twoCell.editAs ?? "twoCell"
  };
}

export function chartAnchorModel(c: ChartHandle): ChartAnchorModel {
  const base: ChartAnchorModel = {
    chartNumber: c.chartNumber,
    chartExNumber: c.chartExNumber,
    range: {
      tl: anchorModel(c.range.tl),
      br: c.range.br ? anchorModel(c.range.br) : undefined,
      editAs: c.range.editAs,
      pos: c.range.pos,
      ext: c.range.ext
    } as ChartAnchorModel["range"]
  };
  return base;
}

// ===========================================================================
// Chart data access
// ===========================================================================

/** Get the full ChartModel from the workbook's chart entries (classic charts only) */
export function chartChartModel(c: ChartHandle): ChartModel | undefined {
  if (c.chartNumber <= 0) {
    return undefined;
  }
  return getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber)?.model;
}

/** Get the structured ChartEx model, when this chart is an Office 2016+ chartEx. */
export function chartChartExModel(c: ChartHandle): ChartExModel | undefined {
  if (c.chartExNumber <= 0) {
    return undefined;
  }
  return getChartExStructuredEntry(getSheetWorkbook(c.worksheet), c.chartExNumber)?.model;
}

/**
 * Vendor-extension elements the parser observed but could not map to a
 * structured field. Populated when the chart was loaded from an existing
 * `.xlsx` whose author emitted `c15:`/`cx14:` style extension tags (often
 * MSO-internal; the OOXML spec treats them as implementation-specific).
 *
 * The array is **purely informational** in the default `preserve` writer
 * mode — structural rebuilds keep the raw XML pass-through that contains
 * those tags. In **`strictTemplateMode`** the writer surfaces this list
 * in its failure message when a mutation cannot be expressed as a raw
 * patch, so authors can decide between:
 *
 *   1. Relaxing `strictTemplateMode` and accepting that a rebuild will
 *      drop these vendor tags, or
 *   2. Reshaping the mutation to land on a patch-friendly path (for
 *      example editing `title` text rather than replacing the whole
 *      `c:chart` subtree).
 *
 * Returns `undefined` if the chart was freshly created (no raw XML was
 * ever parsed) or if every child was recognised. See
 * {@link XlsxWriteOptions.strictTemplateMode} for the writer surface.
 */
export function chartUnknownElements(
  c: ChartHandle
): Array<{ name: string; path: string }> | undefined {
  const classic = chartChartModel(c)?.unknownElements;
  if (classic && classic.length > 0) {
    return classic.slice();
  }
  const chartEx = chartChartExModel(c)?.unknownElements;
  if (chartEx && chartEx.length > 0) {
    return chartEx.slice();
  }
  return undefined;
}

// ===========================================================================
// User-shape drawing part (c:userShapes)
// ===========================================================================

/**
 * Raw XML bytes of the `c:userShapes` drawing part attached to this
 * chart, or `undefined` when the chart has no user shapes. User
 * shapes are annotation overlays (callouts, arrows, free text) that
 * Excel stores in a separate `xl/drawings/drawingN.xml` part using
 * relative anchors — the OOXML spec keeps their DrawingML schema
 * distinct from worksheet drawings, so the library treats the part
 * as opaque bytes for round-trip and programmatic replacement
 * instead of exposing a full structural API.
 *
 * Classic charts only. Returns `undefined` on chartEx charts (they
 * have their own extension mechanism and do not use `c:userShapes`).
 */
export function chartUserShapesXml(c: ChartHandle): Uint8Array | undefined {
  if (c.chartNumber <= 0) {
    return undefined;
  }
  return getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber)?.userShapesXml;
}

/**
 * Replace the `c:userShapes` drawing part for this chart with the
 * supplied raw XML bytes. Passing `undefined` or an empty byte
 * array removes the user-shapes reference entirely (equivalent to
 * {@link removeUserShapes}).
 *
 * The XML must be a complete DrawingML document whose root is a
 * `c:userShapes` element containing `c:relSizeAnchor` /
 * `c:absSizeAnchor` children. The library performs a shallow sanity
 * check only — no schema validation.
 *
 * When a chart did not previously have user shapes, this allocates
 * a new `r:id` and adds the drawing-part rel so the reference is
 * discoverable in `chartN.xml.rels`. When a chart already had user
 * shapes, the existing `r:id` is kept and only the bytes are
 * updated.
 *
 * Classic charts only. Throws on chartEx charts.
 */
export function chartSetUserShapesXml(c: ChartHandle, xml: Uint8Array | string | undefined): void {
  if (c.chartNumber <= 0) {
    throw new ChartOptionsError("Chart.setUserShapesXml is only supported on classic charts.");
  }
  const entry = getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber);
  if (!entry) {
    throw new ChartOptionsError(`Chart ${c.chartNumber} has no registered chart entry.`);
  }
  if (xml === undefined) {
    chartRemoveUserShapes(c);
    return;
  }
  const bytes = typeof xml === "string" ? new TextEncoder().encode(xml) : xml;
  // Empty strings / empty byte arrays are treated the same as `undefined`
  // — they remove the user-shapes reference entirely.
  if (bytes.length === 0) {
    chartRemoveUserShapes(c);
    return;
  }
  // Minimal sanity check — full validation is left to downstream consumers.
  const peek = new TextDecoder().decode(bytes.slice(0, 512));
  if (!peek.includes("userShapes")) {
    throw new ChartOptionsError(
      "Chart.setUserShapesXml expects a DrawingML document whose root is c:userShapes."
    );
  }
  entry.userShapesXml = bytes;
  entry.dirty = true;
  // Reserve an r:id if we didn't have one, and pre-record a matching
  // rel entry so that other allocators on this chart part
  // (e.g. `chart-images.resolvePendingChartImages`) see the id as
  // already taken and don't reuse it. The writer rewrites the
  // `Target` to the final `chartUserShape{N}.xml` path at emission
  // time (xlsx writer, `_writeChart`), so the placeholder Target here
  // is advisory only.
  //
  // We seed the counter from `max(existing numeric suffix) + 1`
  // instead of `rels.length + 1`, because rels can be sparse
  // (e.g. rId1 / rId5 with rId2-4 removed) and `length + 1` would
  // collide with live identifiers in that case.
  if (!entry.model.userShapesRelId) {
    const rels = (entry.rels ??= []);
    const existing = new Set(rels.map(r => r?.Id).filter((id): id is string => Boolean(id)));
    let maxSeen = 0;
    for (const id of existing) {
      const match = /^rId(\d+)$/.exec(id);
      if (match) {
        const n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > maxSeen) {
          maxSeen = n;
        }
      }
    }
    let counter = maxSeen + 1;
    let rid = `rId${counter}`;
    while (existing.has(rid)) {
      counter += 1;
      rid = `rId${counter}`;
    }
    entry.model.userShapesRelId = rid;
    // Push a placeholder rel so downstream allocators see the id as
    // taken. The xlsx writer resolves the Target to the actual
    // drawing part path at emission time.
    //
    // CRITICAL: use `RelType.ChartUserShapes` (the canonical
    // `chartUserShapes`, plural, ECMA-376 URI). An
    // earlier version hardcoded the singular `chartUserShape` here,
    // which drifted from `RelType.ChartUserShapes` used by the xlsx
    // writer (see `xlsx.browser.ts`). The writer couldn't recognise
    // this placeholder as the existing userShapes rel and would push
    // a second rel on every write, producing a duplicate rel entry
    // in the chart rels file.
    const hasUserShapesRel = rels.some(r => r?.Type === RelType.ChartUserShapes);
    if (!hasUserShapesRel) {
      rels.push({
        Id: rid,
        Type: RelType.ChartUserShapes,
        Target: ""
      });
    }
  }
}

/**
 * Drop the `c:userShapes` reference and its backing drawing part.
 * Classic charts only. No-op when the chart has no user shapes.
 */
export function chartRemoveUserShapes(c: ChartHandle): void {
  if (c.chartNumber <= 0) {
    return;
  }
  const entry = getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber);
  if (!entry) {
    return;
  }
  if (!entry.userShapesXml && !entry.model.userShapesRelId) {
    return;
  }
  entry.userShapesXml = undefined;
  entry.dirty = true;
  const relId = entry.model.userShapesRelId;
  entry.model.userShapesRelId = undefined;
  if (relId && Array.isArray(entry.rels)) {
    entry.rels = entry.rels.filter(r => r?.Id !== relId);
  }
  // Also purge the matching rel from the workbook-level `_chartRels`
  // bag. The writer merges `model.chartRels[n]` (which is
  // `_chartRels`) into the emitted .rels file BEFORE folding in
  // `entry.rels`, so cleaning only `entry.rels` leaves the original
  // userShapes rel in place — producing a chart whose XML has no
  // `<c:userShapes>` reference but whose .rels still points at a
  // drawing part that is never emitted.
  const workbook = getSheetWorkbook(c.worksheet);
  const workbookChartRels = workbook._chartRels as
    | Record<number, Array<{ Id?: string; Type?: string }>>
    | undefined;
  if (workbookChartRels && Array.isArray(workbookChartRels[c.chartNumber])) {
    workbookChartRels[c.chartNumber] = workbookChartRels[c.chartNumber].filter(r => {
      // Match on the specific `Id` we just cleared — but also defensively
      // drop any entry whose `Type` points at a userShapes drawing
      // rel, covering the edge case where the model lost track of its
      // authored `userShapesRelId` but the rel is still present.
      if (relId && r?.Id === relId) {
        return false;
      }
      if (r?.Type === RelType.ChartUserShapes) {
        return false;
      }
      return true;
    });
  }
}

/**
 * Chart rendering (`chartToSVG` / `chartToPNG`) lives in `chart-render-ops.ts`
 * so the heavy SVG/PNG renderers stay off the chart *creation* path that
 * `worksheet.ts` / `Workbook` statically reach. Import from there to render.
 */

/** Get the chart title text. Returns undefined if no title. */
export function chartTitle(c: ChartHandle): string | undefined {
  const titleObj =
    chartChartModel(c)?.chart?.title ?? chartChartExModel(c)?.chartSpace?.chart?.title;
  if (!titleObj) {
    return undefined;
  }
  if (titleObj.text) {
    return _chartExtractTextFromRichText(c, titleObj.text);
  }
  // Only consider the strRef cache resolved when it actually contains
  // at least one point. Formula-bound titles are authored with
  // `strRef: { formula, cache: { points: [] } }` (see
  // `chart-builder.ts:makeTitle`), and without the explicit length
  // check this getter returned `""` for every such title that hadn't
  // yet gone through `fillChartCaches` — callers couldn't
  // distinguish "title exists, not yet resolved" from an
  // intentionally-empty title.
  if (titleObj.strRef?.cache?.points && titleObj.strRef.cache.points.length > 0) {
    return titleObj.strRef.cache.points.map(p => p.value).join("");
  }
  // Fall back to rawTx — extract text from <a:t> elements
  if (titleObj.rawTx) {
    return _chartExtractTextFromRawTx(c, titleObj.rawTx);
  }
  return undefined;
}

/**
 * Set the chart title.
 *
 * Accepts:
 * - `undefined` → removes title (sets autoTitleDeleted).
 * - `string` → sets title text. If the existing title had rich-text formatting,
 *   the formatting of the first run is preserved and only the text is replaced.
 * - `ChartRichText` → replaces the title with fully-structured rich text.
 * - `{ formula: string }` → sets the title to a worksheet formula reference.
 */
export function chartSetTitle(
  c: ChartHandle,
  value: string | ChartRichText | { formula: string } | undefined
): void {
  const chart = chartChartModel(c)?.chart ?? chartChartExModel(c)?.chartSpace?.chart;
  if (!chart) {
    return;
  }
  if (value === undefined) {
    _chartMarkDirty(c, true);
    chart.title = undefined;
    chart.autoTitleDeleted = true;
    return;
  }
  if (typeof value === "object" && "formula" in value && typeof value.formula === "string") {
    _chartMarkDirty(c);
    chart.title = {
      strRef: { formula: value.formula, cache: { points: [] } },
      overlay: chart.title?.overlay ?? false
    };
    chart.autoTitleDeleted = false;
    // Repopulate the title cache from the referenced cell(s) so
    // preview callers (toSVG / toPNG) and headless converters can
    // resolve the title text without waiting for a worksheet-side
    // recalc. `fillChartCaches` no-ops for non-formula titles and
    // already-populated caches, so calling it here is safe.
    if (chartIsChartEx(c)) {
      _chartRefreshChartExCaches(c);
    } else {
      _chartRefreshCaches(c);
    }
    return;
  }
  if (typeof value === "object" && "paragraphs" in value) {
    _chartMarkDirty(c);
    // Rich text — shallow-clone the paragraphs array so callers who
    // reuse the same `ChartRichText` object across charts don't
    // accidentally alias mutations. Runs remain shared by reference
    // inside each paragraph — consumers generally treat them as
    // immutable, and a deep clone here is cheap but hides the
    // aliasing concern rather than documents it. Users who mutate
    // a run after assignment should clone the object themselves.
    chart.title = {
      ...(chart.title ?? {}),
      strRef: undefined,
      rawTx: undefined,
      text: { ...value, paragraphs: [...value.paragraphs] },
      overlay: chart.title?.overlay ?? false
    };
    chart.autoTitleDeleted = false;
    return;
  }
  // Plain string — try to preserve first-run formatting of existing title.
  if (typeof value !== "string") {
    // Reach here only when `value` is an object whose shape matches none of
    // the branches above (e.g. `{ formula: 123 }`, `{ foo: 1 }`). Previously
    // we silently returned, which quietly swallowed malformed input; throw
    // instead so callers see the bug at the assignment site.
    throw new ChartOptionsError(
      "Chart.title accepts string | ChartRichText | { formula: string } | undefined. " +
        `Got: ${JSON.stringify(value)}`
    );
  }
  _chartMarkDirty(c, true);
  const existing = chart.title;
  const preservedProps = _chartExtractFirstRunProperties(c, existing);
  chart.title = {
    ...(existing ?? {}),
    strRef: undefined,
    rawTx: undefined,
    text: {
      paragraphs: [
        {
          runs: [{ text: value, properties: preservedProps }]
        }
      ]
    },
    overlay: existing?.overlay ?? false
  };
  chart.autoTitleDeleted = false;
}

/**
 * Set the chart title using structured rich text.
 * Convenience method equivalent to `chart.title = richText`.
 */
export function chartSetTitleRichText(c: ChartHandle, richText: ChartRichText): void {
  chartSetTitle(c, richText);
}

/**
 * Get the structured rich text of the chart title.
 * Returns undefined if the title is unset, formula-only, or captured as rawTx.
 */
export function chartTitleRichText(c: ChartHandle): ChartRichText | undefined {
  return (
    chartChartModel(c)?.chart?.title?.text ?? chartChartExModel(c)?.chartSpace?.chart?.title?.text
  );
}

/** Get the chart type groups in the plot area */
export function chartChartTypes(c: ChartHandle): ChartTypeGroup[] {
  return chartChartModel(c)?.chart?.plotArea?.chartTypes ?? [];
}

/** Get the chart axes */
export function chartAxes(c: ChartHandle): ChartAxis[] {
  return chartChartModel(c)?.chart?.plotArea?.axes ?? [];
}

/** Get the chart legend */
export function chartLegend(c: ChartHandle): ChartLegend | undefined {
  return chartChartModel(c)?.chart?.legend ?? chartChartExModel(c)?.chartSpace?.chart?.legend;
}

/** Set the chart legend */
export function chartSetLegend(c: ChartHandle, value: ChartLegend | undefined): void {
  const chart = chartChartModel(c)?.chart ?? chartChartExModel(c)?.chartSpace?.chart;
  if (chart) {
    _chartMarkDirty(c, true);
    chart.legend = value;
  }
}

/**
 * Get the chart-level shape properties. Works for both classic charts
 * (`c:chartSpace/c:spPr`) and ChartEx (`cx:chartSpace/cx:spPr` — the
 * Chart2014 schema puts `spPr` on `chartSpace`, not on `chart`).
 */
export function chartSpPr(c: ChartHandle): ShapeProperties | undefined {
  const model = chartChartModel(c);
  if (model) {
    return model.spPr;
  }
  // ChartEx stores chart-frame shape properties on `CT_ChartSpace/spPr`.
  // Legacy files that (incorrectly) placed `spPr` on `<cx:chart>`
  // are migrated by the parser into `chartSpace.spPr` at load
  // time — so this getter no longer needs a fallback path.
  return chartChartExModel(c)?.chartSpace?.spPr;
}

/**
 * Set the chart-level shape properties. Routes to either
 * `ChartModel.spPr` (classic) or `ChartExModel.chartSpace.spPr`
 * (ChartEx); previously the ChartEx branch was a silent no-op, and
 * the fix before that mis-targeted `chart.spPr` — which is not a
 * valid child of `CT_Chart` in the Chart2014 schema (chart-frame
 * styling belongs to `CT_ChartSpace/spPr`).
 */
export function chartSetSpPr(c: ChartHandle, value: ShapeProperties | undefined): void {
  const cm = chartChartModel(c);
  if (cm) {
    _chartMarkDirty(c);
    cm.spPr = value;
    return;
  }
  const chartSpace = chartChartExModel(c)?.chartSpace;
  if (chartSpace) {
    _chartMarkDirty(c);
    chartSpace.spPr = value;
  }
}

/**
 * Get an axis by its ID.
 */
export function chartGetAxis(c: ChartHandle, axId: number): ChartAxis | undefined {
  return chartAxes(c).find(ax => ax.axId === axId);
}

/**
 * Get the category (X) axis, if any.
 */
export function chartCategoryAxis(c: ChartHandle): ChartAxis | undefined {
  return chartAxes(c).find(ax => ax.axisType === "cat" || ax.axisType === "date");
}

/**
 * Get the value (Y) axis, if any.
 */
export function chartValueAxis(c: ChartHandle): ChartAxis | undefined {
  return chartAxes(c).find(ax => ax.axisType === "val");
}

/** Get the plot area for direct manipulation */
export function chartPlotArea(c: ChartHandle): PlotArea | undefined {
  return chartChartModel(c)?.chart?.plotArea;
}

export function chartMutate(
  c: ChartHandle,
  mutator: (model: ChartModel) => void,
  options: { preferRawPatch?: boolean; requireRawPatch?: boolean } = {}
): ChartHandle {
  const model = chartChartModel(c);
  if (!model) {
    throw new ChartOptionsError(
      "Cannot mutate a classic chart model because this chart is ChartEx or missing."
    );
  }
  const draft = structuredClone(model);
  mutator(draft);
  const committed = structuredClone(draft);
  syncObjectContents(model, committed);
  _chartMarkDirty(c, options.preferRawPatch ?? false, options.requireRawPatch ?? false);
  return c;
}

export function chartMutateChartEx(
  c: ChartHandle,
  mutator: (model: ChartExModel) => void,
  options: { preferRawPatch?: boolean; requireRawPatch?: boolean } = {}
): ChartHandle {
  const model = chartChartExModel(c);
  if (!model) {
    throw new ChartOptionsError(
      "Cannot mutate a ChartEx model because this chart is classic or missing."
    );
  }
  const draft = structuredClone(model);
  mutator(draft);
  if (!draft.chartSpace?.chart || !draft.chartSpace.chartData) {
    throw new ChartOptionsError(
      "Chart.mutateChartEx produced an invalid model: chartSpace.chart and chartSpace.chartData are required."
    );
  }
  // Invalidate the model-level rawXml cache so subsequent calls to
  // `renderChartEx(model)` (e.g. standalone preview, tests) honour the
  // mutation instead of short-circuiting to the bytes captured at parse
  // time. The xlsx writer path has its own change-detection (see
  // `hasChartExEntryChanged` in xlsx.browser.ts) and does not depend on
  // this flag, but direct consumers of `renderChartEx` do.
  //
  // `preferRawPatch` consumers explicitly opt in to surgical byte
  // patching — they keep the rawXml so the patcher in xlsx.browser.ts
  // can reuse it.
  if (!options.preferRawPatch && !options.requireRawPatch) {
    draft.rawXml = undefined;
    // Also clear title-level rawTx when the structured `text` was
    // updated. Otherwise the writer's "structured path wins over
    // raw" rule correctly routes the new text, but downstream
    // snapshotters (change-detection / test helpers) still see the
    // stale rawTx bytes and conclude the model hasn't been mutated.
    // Clearing here unifies the invalidation model.
    const title = draft.chartSpace?.chart?.title;
    if (title?.text && title.rawTx !== undefined) {
      title.rawTx = undefined;
    }
  }
  const committed = structuredClone(draft);
  syncObjectContents(model, committed);
  _chartMarkDirty(c, options.preferRawPatch ?? false, options.requireRawPatch ?? false);
  return c;
}

function syncObjectContents<T extends object>(target: T, source: T): void {
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  for (const [key, value] of Object.entries(sourceRecord)) {
    const current = targetRecord[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      const shared = Math.min(current.length, value.length);
      for (let index = 0; index < shared; index++) {
        if (isPlainObject(current[index]) && isPlainObject(value[index])) {
          syncObjectContents(current[index], value[index]);
        } else {
          current[index] = structuredClone(value[index]);
        }
      }
      current.splice(shared, current.length - shared, ...structuredClone(value.slice(shared)));
    } else if (isPlainObject(current) && isPlainObject(value)) {
      syncObjectContents(current, value);
    } else {
      targetRecord[key] = structuredClone(value);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Set the built-in chart style by index.
 *
 * Writes `<c:style val="N"/>` on the classic chart (`chartN.xml`).
 * Valid values are 1–48, matching the legacy Excel 2007/2010 style
 * catalogue. This is the lightweight
 * option — it does **not** emit a `styleN.xml` / `colorsN.xml` sidecar;
 * for modern Office-2013-era styling use {@link setChartStyle} instead.
 *
 * ChartEx charts do not honour this field; calling `setStyle` on one
 * throws, which matches OOXML: `c:style` only exists in the classic
 * `c:` namespace.
 *
 * @param style - Integer in the range 1–48.
 * @throws {ChartOptionsError} when `style` is outside 1–48 or the
 *         chart is a ChartEx.
 */
export function chartSetStyle(c: ChartHandle, style: number): ChartHandle {
  if (!Number.isInteger(style) || style < 1 || style > 48) {
    throw new ChartOptionsError(
      `Chart.setStyle: built-in style must be an integer in 1..48, received ${style}`
    );
  }
  const model = chartChartModel(c);
  if (!model) {
    throw new ChartOptionsError(
      "Chart.setStyle is only valid on classic charts; ChartEx does not honour `c:style`"
    );
  }
  model.style = style;
  _chartMarkDirty(c);
  return c;
}

/**
 * Alias for {@link setStyle} using the built-in-style naming
 * convention. Equivalent in
 * every way — both write the same `<c:style val>` attribute.
 */
export function chartSetBuiltInStyle(c: ChartHandle, style: number): ChartHandle {
  return chartSetStyle(c, style);
}

/**
 * Add a series to a chart type group.
 *
 * The series' `index` and `order` fields are rewritten to the next
 * available slot in the target group so callers can safely push
 * series that were built with a placeholder index (e.g. a reused
 * result of `buildChartSeriesForType(..., 0)`). OOXML requires
 * `c:ser/@idx` to be unique within the chart; leaving caller-provided
 * values alone silently produces a chart with duplicate `<c:idx>`
 * entries that Excel either rejects or collapses to a single series.
 *
 * @param series - The series object matching the expected series type for the chart.
 * @param groupIndex - 0-based index of the chart type group (for combo charts). Defaults to 0.
 */
export function chartAddSeries(c: ChartHandle, series: SeriesBase, groupIndex = 0): void {
  const ctg = chartChartTypes(c)[groupIndex];
  if (ctg) {
    _chartMarkDirty(c);
    const nextIdx = _chartNextSeriesIndex(c);
    series.index = nextIdx;
    series.order = nextIdx;
    // `ctg.series` is a discriminated union keyed on `ctg.type` — TS can't
    // verify that `series` matches the expected variant from a generic
    // `SeriesBase`. Callers are documented as responsible for passing a
    // matching shape; we widen through `unknown` to avoid `as any` while
    // keeping a single signature. Runtime validation lives in
    // `buildChartModel`, which is invoked when the chart is serialised.
    (ctg.series as SeriesBase[]).push(series);
    // Refresh caches so the first preview render (and any
    // change-detection snapshot taken before the next save cycle)
    // sees the actual data rather than the blank shell the caller
    // probably built via `buildChartSeriesForType`. `updateSeries`
    // and `addSeriesFromOptions` already do this; the lower-level
    // `addSeries` path previously skipped the refresh, so a chart
    // authored via direct `ctg.series.push`-style flows displayed
    // empty until the next save / reload cycle.
    _chartRefreshCaches(c);
  }
}

/**
 * Remove a series from a chart type group by index.
 *
 * @param index - 0-based index of the series within the group.
 * @param groupIndex - 0-based index of the chart type group (for combo charts). Defaults to 0.
 * @returns The removed series, or undefined if out of range.
 */
export function chartRemoveSeries(
  c: ChartHandle,
  index: number,
  groupIndex = 0
): SeriesBase | undefined {
  const ctg = chartChartTypes(c)[groupIndex];
  if (!ctg || index < 0 || index >= ctg.series.length) {
    return undefined;
  }
  _chartMarkDirty(c);
  return ctg.series.splice(index, 1)[0];
}

/**
 * Get a series from a chart type group.
 *
 * @param index - 0-based index of the series within the group.
 * @param groupIndex - 0-based index of the chart type group (for combo charts). Defaults to 0.
 */
export function chartGetSeries(
  c: ChartHandle,
  index: number,
  groupIndex = 0
): SeriesBase | undefined {
  const ctg = chartChartTypes(c)[groupIndex];
  if (!ctg) {
    return undefined;
  }
  return ctg.series[index];
}

/** Update common fields on an existing classic chart series. */
export function chartUpdateSeries(
  c: ChartHandle,
  index: number,
  options: Partial<AddChartSeriesOptions>,
  groupIndex = 0
): boolean {
  const series = chartGetSeries(c, index, groupIndex);
  if (!series) {
    return false;
  }
  // Apply the patch first so a malformed option (e.g. an unknown
  // enum on `lineDash`) throws *before* we flip the dirty flag. The
  // previous ordering left the chart entry marked dirty on failure,
  // which then forced a full rebuild on the next write even though
  // no mutation had actually landed on the model.
  applyChartSeriesOptionsPatch(series, options, chartChartTypes(c)[groupIndex]?.type);
  // Resolve any staged `series.spPr.fill.blip._pendingImage` that the
  // patch placed on the series. The initial `addChart` path does
  // this in the worksheet's `addChart` hook (same for `addChartsheet`
  // / `replaceChartsheetChart`), but post-registration mutations via
  // `updateSeries` had no equivalent pass — the `_pendingImage`
  // payload sat on the model and the xlsx writer emitted
  // `<a:blipFill>` without a matching rel, leaving Excel with a
  // broken picture reference. Match the registration paths so
  // pictureFill works uniformly for create and update.
  if (options.pictureFill?.image !== undefined) {
    _chartResolveSeriesPictureFills(c);
  }
  // Refresh numeric / string caches when the patch introduced a new
  // formula reference. `applyChartSeriesOptionsPatch` always replaces
  // `target.val` / `target.cat` / `target.xVal` / `target.bubbleSize`
  // with a fresh `makeNumRef` / `makeStrRef` whose `cache.points` is
  // empty, so preview readers and headless converters see blank
  // values until the next `fillChartCaches` pass. Calling it here
  // keeps parity with the worksheet's initial `addChart` step.
  if (
    options.values !== undefined ||
    options.categories !== undefined ||
    options.xValues !== undefined ||
    options.bubbleSize !== undefined
  ) {
    _chartRefreshCaches(c);
  }
  _chartMarkDirty(c, true);
  return true;
}

/** Add a series from high-level options, matching the target chart type group. */
export function chartAddSeriesFromOptions(
  c: ChartHandle,
  options: AddChartSeriesOptions,
  groupIndex = 0
): boolean {
  const ctg = chartChartTypes(c)[groupIndex];
  if (!ctg) {
    return false;
  }
  const index = _chartNextSeriesIndex(c);
  // `buildChartSeriesForType` can throw for invalid options (e.g. a
  // `pie` chart given `scatter`-only fields). Build first, mark
  // dirty only after the push lands — otherwise a failing build
  // leaves the entry marked dirty without any change to serialise.
  //
  // `buildChartSeriesForType` returns the exact variant matching `ctg.type`,
  // but TS sees `SeriesBase`. Widen via `unknown` (instead of `as any`) so
  // the tighter typing of the union is preserved at the push site.
  const built = buildChartSeriesForType(ctg.type, options, index);
  (ctg.series as SeriesBase[]).push(built);
  // Same rationale as `updateSeries`: if the new series carries a
  // pictureFill image, resolve the pending payload into an actual
  // media entry + chart rel so the writer emits valid XML.
  if (options.pictureFill?.image !== undefined) {
    _chartResolveSeriesPictureFills(c);
  }
  // Newly added series always carry empty caches on their val /
  // cat / xVal references — refresh so the first preview render
  // sees the actual data rather than a blank shell.
  _chartRefreshCaches(c);
  _chartMarkDirty(c);
  return true;
}

/** Update the value range for a series. */
export function chartSetSeriesValues(
  c: ChartHandle,
  index: number,
  values: string,
  groupIndex = 0
): boolean {
  return chartUpdateSeries(c, index, { values }, groupIndex);
}

/** Update the category range for a series. */
export function chartSetSeriesCategories(
  c: ChartHandle,
  index: number,
  categories: string,
  groupIndex = 0
): boolean {
  return chartUpdateSeries(c, index, { categories }, groupIndex);
}

/** Update the series display name or formula reference. */
export function chartSetSeriesName(
  c: ChartHandle,
  index: number,
  name: NonNullable<AddChartSeriesOptions["name"]>,
  groupIndex = 0
): boolean {
  return chartUpdateSeries(c, index, { name }, groupIndex);
}

/** Get the total number of series across all chart type groups. */
export function chartTotalSeriesCount(c: ChartHandle): number {
  return chartChartTypes(c).reduce((sum, ctg) => sum + (ctg.series?.length ?? 0), 0);
}

/**
 * Get the number of series in a specific chart type group.
 *
 * @param groupIndex - 0-based index of the chart type group (defaults to 0).
 */
export function chartGetSeriesCount(c: ChartHandle, groupIndex = 0): number {
  const ctg = chartChartTypes(c)[groupIndex];
  return ctg?.series?.length ?? 0;
}

// ===========================================================================
// Chart cloning and duplication
// ===========================================================================

/**
 * Create a deep copy of this chart and add it to a target worksheet.
 * The new chart receives a fresh chartNumber; the original is untouched.
 *
 * @param targetWs - Worksheet to receive the clone. Defaults to this chart's worksheet.
 * @param range - Anchor range for the clone. Defaults to the original range.
 * @returns The new chartNumber in the target workbook.
 */
export function chartCopyTo(
  c: ChartHandle,
  targetWs: WorksheetData,
  range?: AddChartRange
): number {
  const sourceModel = chartChartModel(c);
  const sourceChartExModel = chartChartExModel(c);
  if (!sourceModel && !sourceChartExModel) {
    throw new ChartOptionsError("Cannot copy chart because no chart model is available.");
  }
  const targetRange = range ?? _chartCloneRange(c);
  if (sourceChartExModel) {
    const newChartExNumber = registerChartEx(targetWs, deepClone(sourceChartExModel), targetRange);
    // Copy chartEx-specific sidecars (the `_chartExRels` bag of
    // authored relationship entries). Previously the copy dropped
    // every rel, so a chartEx with `cx14:` extension references or
    // embedded media ended up pointing at undefined rel ids on the
    // clone.
    copyChartExSidecars(
      getSheetWorkbook(c.worksheet),
      c.chartExNumber,
      newChartExNumber,
      getSheetWorkbook(targetWs)
    );
    return newChartExNumber;
  }
  const clonedModel = deepClone(sourceModel!);
  const chartNumber = registerChart(targetWs, clonedModel, targetRange);
  copyChartSidecars(
    getSheetWorkbook(c.worksheet),
    c.chartNumber,
    chartNumber,
    getSheetWorkbook(targetWs)
  );
  // `_registerChart` creates a minimal entry (model only). Carry
  // the per-entry `userShapesXml` bytes across so annotation
  // overlays (callouts, arrows, text boxes the user drew on top of
  // the chart) survive the clone. Without this the duplicate loses
  // every overlay — the drawing part is referenced via a per-entry
  // rel that `copyChartSidecars` already copied, but the backing
  // bytes live on the entry itself and were being dropped.
  //
  // Also carry over `entry.rels`. The workbook-level
  // `copyChartSidecars` hook copies `_chartRels[n]` (style / colors /
  // on-disk image rels), but rels generated programmatically by
  // `resolvePendingChartImages` (for a `series.spPr.fill.blip`
  // picture fill) and the user-shapes placeholder rel pushed by
  // `setUserShapesXml` live on `entry.rels`. Without this copy,
  // the clone's `spPr.fill.blip.relationshipId` / `model.userShapesRelId`
  // referenced in the deep-cloned model point at rel IDs that
  // only exist on the SOURCE entry — the target writes out a
  // chart whose XML uses `r:embed="rId{N}"` but whose .rels has
  // no matching entry, so Excel renders the picture-fill series
  // as a broken / blank fill.
  const srcEntry = getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber);
  const dstEntry = getChartEntry(getSheetWorkbook(targetWs), chartNumber);
  if (srcEntry && dstEntry) {
    if (srcEntry.userShapesXml) {
      dstEntry.userShapesXml = srcEntry.userShapesXml.slice();
    }
    if (Array.isArray(srcEntry.rels) && srcEntry.rels.length > 0) {
      // Shallow-clone each rel so later mutations on the source
      // don't leak into the clone. The writer only reads `Id`,
      // `Type`, `Target`, and `TargetMode` off these entries, so
      // a spread is sufficient.
      dstEntry.rels = srcEntry.rels.map(rel => ({ ...rel }));
    }
  }
  return chartNumber;
}

/**
 * Create a deep copy of this chart in the same worksheet.
 * @param range - Anchor for the clone (defaults to shifting right of original).
 */
export function chartClone(c: ChartHandle, range?: AddChartRange): number {
  return chartCopyTo(c, c.worksheet, range ?? _chartCloneRange(c));
}

function _chartCloneRange(c: ChartHandle): AddChartRange {
  // Two-cell anchor: shift the clone right by the original's width.
  if (c.range.br) {
    const tl = anchorModel(c.range.tl);
    const br = anchorModel(c.range.br);
    const width = br.nativeCol - tl.nativeCol;
    return {
      tl: { col: br.nativeCol + 1, row: tl.nativeRow },
      br: { col: br.nativeCol + 1 + width, row: br.nativeRow }
    };
  }
  // Absolute anchor: shift horizontally by the extent so the clone
  // sits alongside the original. Preserve `editAs: "absolute"` so
  // the writer emits `<xdr:absoluteAnchor>` — the previous fallback
  // degraded every non-two-cell anchor into a twoCell placed
  // on top of the original, both changing the anchor kind and
  // overlapping the source chart 100%.
  if (c.range.pos && c.range.ext) {
    return {
      pos: {
        x: c.range.pos.x + c.range.ext.cx,
        y: c.range.pos.y
      },
      ext: { cx: c.range.ext.cx, cy: c.range.ext.cy },
      editAs: "absolute"
    };
  }
  // One-cell anchor: shift the `tl` column right by enough columns
  // to clear the original's extent. Converting the EMU width back
  // to a column count is approximate (Excel column widths vary per
  // sheet), so estimate at `DEFAULT_CHART_WIDTH_COLS` for
  // consistency with the two-cell fallback and keep `editAs:
  // "oneCell"` so the writer emits `<xdr:oneCellAnchor>`.
  if (c.range.ext) {
    return {
      tl: {
        col: c.range.tl.nativeCol + DEFAULT_CHART_WIDTH_COLS,
        row: c.range.tl.nativeRow
      },
      ext: { cx: c.range.ext.cx, cy: c.range.ext.cy },
      editAs: "oneCell"
    };
  }
  // No extent at all (should not happen in practice — `parseRange`
  // always populates at least `ext` for oneCell/absolute and `br` for
  // twoCell). Fall back to a two-cell shifted right by the default
  // chart extent.
  return {
    tl: {
      col: c.range.tl.nativeCol + DEFAULT_CHART_WIDTH_COLS,
      row: c.range.tl.nativeRow
    },
    br: {
      col: c.range.tl.nativeCol + 2 * DEFAULT_CHART_WIDTH_COLS,
      row: c.range.tl.nativeRow + DEFAULT_CHART_HEIGHT_ROWS
    }
  };
}

// ===========================================================================
// Private helpers
// ===========================================================================

/**
 * Compute the next available series index across all chart type groups.
 * OOXML `c:ser/@idx` must be unique within the entire chart. Scans for
 * the maximum authored index (not the series count) so post-removeSeries
 * state and non-contiguous authored indices still produce a unique slot.
 */
function _chartNextSeriesIndex(c: ChartHandle): number {
  let maxIdx = -1;
  for (const g of chartChartTypes(c)) {
    for (const s of g.series) {
      const idx = typeof s.index === "number" ? s.index : -1;
      if (Number.isFinite(idx) && idx > maxIdx) {
        maxIdx = idx;
      }
    }
  }
  return maxIdx + 1;
}

function _chartMarkDirty(c: ChartHandle, preferRawPatch = false, requireRawPatch = false): void {
  if (c.chartNumber > 0) {
    const entry = getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber);
    if (entry) {
      entry.dirty = true;
      // Once any mutation drops `preferRawPatch`, a full rebuild is
      // required — a subsequent minor mutation must not re-enable
      // patching. Conversely, if the entry was already marked for
      // full rebuild, a minor mutation should not downgrade it back
      // to patch mode.
      if (!preferRawPatch) {
        entry.preferRawPatch = false;
      } else if (entry.preferRawPatch === undefined) {
        entry.preferRawPatch = true;
      }
      if (requireRawPatch) {
        entry.requireRawPatch = true;
      }
    }
  }
  if (c.chartExNumber > 0) {
    const entry = getChartExStructuredEntry(getSheetWorkbook(c.worksheet), c.chartExNumber);
    if (entry) {
      entry.dirty = true;
      if (!preferRawPatch) {
        entry.preferRawPatch = false;
      } else if (entry.preferRawPatch === undefined) {
        entry.preferRawPatch = true;
      }
      if (requireRawPatch) {
        entry.requireRawPatch = true;
      }
      // Invalidate the ChartExModel.rawXml cache on every structural
      // mutation (title / legend / spPr setters, addSeries etc.) —
      // direct consumers of `renderChartEx(model)` (standalone
      // preview, tests) short-circuit to `model.rawXml` when present
      // and would otherwise silently drop the mutation. The
      // `preferRawPatch` opt-in keeps the bytes so the xlsx writer
      // can still do surgical byte patching on them.
      if (!preferRawPatch && !requireRawPatch && entry.model) {
        entry.model.rawXml = undefined;
      }
    }
  }
}

/**
 * Resolve any `_pendingImage` payloads this chart's series carry into
 * workbook media entries + chart relationships. Used by
 * `updateSeries` / `addSeriesFromOptions` when a caller adds a
 * picture fill *after* registration — the initial `addChart` /
 * `addChartsheet` path already calls `resolvePendingChartImages`,
 * but post-registration mutations previously left `_pendingImage`
 * un-registered and the writer emitted `<a:blipFill>` pointing at a
 * missing rel.
 *
 * Uses the same resolver helper as the initial path, so rel id
 * allocation, collision checks against `_chartRels`, and media
 * naming stay centralised.
 */
function _chartResolveSeriesPictureFills(c: ChartHandle): void {
  if (c.chartNumber <= 0) {
    return;
  }
  const entry = getChartEntry(getSheetWorkbook(c.worksheet), c.chartNumber);
  if (!entry) {
    return;
  }
  try {
    resolvePendingChartImages(entry, getSheetWorkbook(c.worksheet), c.chartNumber);
  } catch {
    // Best-effort: a malformed image payload should not take down
    // the surrounding `updateSeries` / `addSeriesFromOptions` call.
    // The series keeps its `pictureOptions`; only the blip-fill
    // registration is skipped.
  }
}

/**
 * Rebuild numeric / string caches on this chart's model from the
 * current worksheet data. Callers mutating formula references after
 * registration (`updateSeries`, `addSeriesFromOptions`, title setter
 * with `{ formula }`) invoke this so preview renders and the
 * snapshot-based change detector see populated points instead of
 * the empty `{ points: [] }` shell the builders install.
 *
 * `fillChartCaches` short-circuits on already-populated caches, so
 * repeated calls across a burst of mutations are effectively O(N)
 * in the number of *new* references.
 */
function _chartRefreshCaches(c: ChartHandle): void {
  const model = chartChartModel(c);
  if (!model) {
    return;
  }
  try {
    // Pass `c.worksheet` as the resolver context so sheet-scoped
    // defined names on this chart's owning sheet outrank workbook-
    // scoped names of the same bare name (matches Excel resolution
    // order and the `addChart` path in `Worksheet`).
    fillChartCaches(model, getSheetWorkbook(c.worksheet), c.worksheet);
  } catch {
    // Cache population is best-effort; a bad reference in one
    // series should not prevent the mutation from landing. The
    // writer still emits the new formula, and a later workbook-
    // wide pass can populate the cache when called explicitly.
  }
}

/**
 * Populate ChartEx data caches (`strDim.levels` / `numDim.levels`) from
 * the workbook's worksheet data so that preview renders see actual
 * values instead of empty arrays.
 *
 * The builder marks hierarchical dimensions with `_skipCache` to
 * prevent the XML writer from emitting flat cache levels (which
 * confuses Excel's hierarchy renderer). However, the in-memory
 * renderer still needs the data. We temporarily clear the flag,
 * fill, then restore it so the writer behaviour is unaffected.
 */
export function _chartRefreshChartExCaches(c: ChartHandle): void {
  const model = chartChartExModel(c);
  if (!model) {
    return;
  }
  try {
    fillChartExCachesForRendering(model, getSheetWorkbook(c.worksheet), c.worksheet);
  } catch {
    // Best-effort — same rationale as _refreshCaches.
  }
}

function _chartExtractTextFromRichText(c: ChartHandle, rt: ChartRichText): string {
  return rt.paragraphs.map(p => (p.runs ?? []).map(r => r.text).join("")).join("\n");
}

function _chartExtractTextFromRawTx(c: ChartHandle, rawTx: string): string | undefined {
  // Extract all <a:t>…</a:t> text content from raw c:tx XML.
  // Also check <c:v>…</c:v> for strRef-based titles.
  //
  // Uses `matchAll` rather than `RegExp.exec` + shared `lastIndex` so
  // concurrent calls (extracting multiple titles in parallel promise
  // chains) cannot interleave each other's iterator state.
  const parts: string[] = [];
  for (const match of rawTx.matchAll(RAW_TX_AT_RE)) {
    parts.push(_chartDecodeXmlEntities(c, match[1]));
  }
  if (parts.length > 0) {
    return parts.join("");
  }
  for (const match of rawTx.matchAll(RAW_TX_CV_RE)) {
    parts.push(_chartDecodeXmlEntities(c, match[1]));
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function _chartDecodeXmlEntities(c: ChartHandle, text: string): string {
  // Single-pass decoder so sequences like `&amp;lt;` (the XML-encoded
  // form of a literal `&lt;`) decode to `&lt;` — NOT to `<`. Chaining
  // `.replace(/&amp;/g,"&").replace(/&lt;/g,"<")` produced the double-
  // decode by accident: the first replace turned `&amp;lt;` into
  // `&lt;`, which the second step then decoded as `<`. A title
  // authored as literal `&lt;tag&gt;` would round-trip as `<tag>`,
  // silently corrupting the user's text.
  return text.replace(
    /&(?:([A-Za-z]+)|#x([0-9A-Fa-f]+)|#(\d+));/g,
    (match, name: string | undefined, hex: string | undefined, dec: string | undefined) => {
      if (name !== undefined) {
        switch (name) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          case "apos":
            return "'";
          default:
            return match;
        }
      }
      if (hex !== undefined) {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (dec !== undefined) {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    }
  );
}

/**
 * Extract the run properties of the first text run in an existing title,
 * if any. Used to preserve formatting when replacing plain-string title
 * text.
 *
 * We prefer the structured path (`title.text.paragraphs[0].runs[0]`) and
 * fall back to parsing the first `<a:rPr>...</a:rPr>` block out of
 * `rawTx`. The fallback used to only read *attributes* off the opening
 * tag (size / bold / italic / underline / strike / lang), which meant
 * the `<a:solidFill>` colour child and `<a:latin>` / `<a:cs>` typefaces
 * were silently stripped when a plain-string title replaced a
 * rich-text title. Now we delegate to `parseTxPr` (the same helper the
 * chart-space xform uses for the full txPr tree) so every supported
 * rPr field round-trips faithfully.
 */
function _chartExtractFirstRunProperties(
  c: ChartHandle,
  title: ChartTitle | undefined
): ChartTextProperties | undefined {
  if (!title) {
    return undefined;
  }
  // Structured path — cheapest and most complete.
  const firstRun = title.text?.paragraphs?.[0]?.runs?.[0];
  if (firstRun?.properties) {
    return { ...firstRun.properties };
  }
  // rawTx path — isolate the first `<a:rPr>…</a:rPr>` fragment (including
  // the self-closing variant) and delegate parsing to `parseTxPr`, which
  // understands colour, font family, east-asian / complex-script
  // typefaces and the run-level number format.
  if (title.rawTx) {
    const selfClosing = /<a:rPr\b[^>]*\/>/.exec(title.rawTx);
    const openClose = /<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(title.rawTx);
    const rPrFragment =
      openClose && (!selfClosing || openClose.index <= selfClosing.index)
        ? openClose[0]
        : selfClosing?.[0];
    if (rPrFragment) {
      // `parseTxPr` looks for `<a:defRPr>` and `<a:rPr>` fragments inside
      // the passed-in raw XML; wrapping in a minimal `<c:txPr>` so it
      // finds exactly our fragment.
      const synthetic = `<c:txPr>${rPrFragment}</c:txPr>`;
      const parsed = parseTxPr({ _rawXml: synthetic });
      // `parsed` still contains `_rawXml`; strip it so the run properties
      // don't drag along a synthetic wrapper. Callers (setter for
      // `title`) only use the structured fields.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _rawXml, ...structured } = parsed;
      return structured;
    }
  }
  return undefined;
}

/**
 * Deep-clone a chart model. Uses `structuredClone` which is always available
 * in our supported environments (Node 22+, all modern browsers) and handles
 * the `Uint8Array` captured on {@link ChartExModel.rawXml} correctly — the
 * older `JSON.parse(JSON.stringify(...))` fallback stripped the typed-array
 * prototype and corrupted round-trip data.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

export { buildChartModel };
