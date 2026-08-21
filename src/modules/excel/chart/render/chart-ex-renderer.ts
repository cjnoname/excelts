/**
 * ChartEx renderer — renders a ChartExModel to SVG / PNG / vector PDF.
 *
 * This file owns the "render to image" responsibility (SVG string
 * emission, PNG rasterisation, and vector PDF drawing). The companion
 * `chart-ex-serialize.ts` owns the orthogonal "emit cx: OOXML XML"
 * responsibility. The two files share no private helpers — only
 * neutral utilities from `chart-utils` — so neither imports the other.
 */

import { cssColour } from "@draw/colour";
import { renderNode } from "@draw/render";
import type { DrawSurface } from "@draw/surface";
import { SvgSurface } from "@draw/svg";
import { IDENTITY, rectNode } from "@draw/types";
import type { DrawList, DrawNode, DrawPaint, DrawPathCommand } from "@draw/types";
import type {
  ChartExAxis,
  ChartExDataEntry,
  ChartExModel,
  ChartExSeries
} from "@excel/chart/model/chart-ex-types";
import type { ChartTitle, ShapeProperties } from "@excel/chart/model/types";
import {
  boxWhiskerNodes,
  columnNodes,
  funnelNodes,
  hexagonPoints,
  lineNode,
  multilineTextNode,
  paretoOverlayNodes,
  polygonNode,
  sunburstNodes,
  textNode,
  treemapNodes,
  waterfallConnectorNodes,
  waterfallNodes
} from "@excel/chart/render/chart-ex-nodes";
import type { WaterfallSpan } from "@excel/chart/render/chart-ex-nodes";
import { createChartPdfDrawSurface } from "@excel/chart/render/chart-pdf-draw-surface";
import type {
  ChartPdfDrawingSurface,
  ChartRenderOptions,
  RegionMapDataOptions,
  RegionMapMatchRule
} from "@excel/chart/render/chart-renderer";
import { renderSvgToPng } from "@excel/chart/render/chart-renderer";
import { rasterizeDrawList } from "@excel/chart/render/draw-raster-png";
import type { ResolvedRing, TopologyLike } from "@excel/chart/render/topojson";
import { resolveTopologyObject } from "@excel/chart/render/topojson";
import type { ChartRect } from "@excel/chart/shared/chart-utils";
import {
  COLORS,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  TEXT_LINE_HEIGHT_EM,
  clamp01,
  escapeXmlAttr,
  formatNumber,
  insetRect,
  interpolateColor,
  previewShapeFillColor,
  singleLineLabel,
  densifySparsePoints,
  splitTextLines
} from "@excel/chart/shared/chart-utils";
import { getSpPrFill } from "@excel/chart/shared/shape-properties";
import { ChartOptionsError } from "@excel/errors";

/**
 * Local alias kept for file-level readability. ChartEx code has always
 * called these `SvgRect`; the underlying shape matches the shared
 * {@link ChartRect} exactly.
 */
type SvgRect = ChartRect;

/**
 * One series' worth of drawing.
 *
 * `mode` is present only for a region map, which reports whether it drew from real
 * topology, the built-in centroid preview or the hex-tile fallback. That is a fact
 * about a *decision*, not about geometry, so only the SVG serialiser records it (as a
 * `data-region-map-mode` attribute); every other backend just draws the nodes.
 */
interface ChartExSeriesLayer {
  readonly nodes: readonly DrawNode[];
  readonly mode?: string;
}

/**
 * Everything the three backends need to draw one ChartEx chart.
 *
 * The size, the title, the plot rectangle, the series list and the legend were each
 * derived three times — once in {@link renderChartExSvg}, once in
 * {@link chartExDrawList} and once in {@link drawChartExPdf}. Three readings of one
 * model is precisely how the title came out 16pt in PDF and 18pt in SVG, and how the
 * no-legend case ended up with different margins on different backends. Deriving it
 * once removes the opportunity.
 */
interface ChartExPlan {
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly title?: DrawNode;
  readonly series: readonly ChartExSeriesLayer[];
  readonly legend: readonly DrawNode[];
}

/**
 * Derive the shared plan.
 *
 * `boxWidth` / `boxHeight` are the drawing box, which is the render options' size for
 * SVG and PNG and the destination rectangle's size for PDF.
 */
function chartExPlan(
  model: ChartExModel,
  options: ChartRenderOptions,
  boxWidth: number,
  boxHeight: number
): ChartExPlan {
  const title = options.title ?? chartTitleText(model.chartSpace.chart.title);
  // Count the title's paragraphs so `getPlotRect` can expand the top margin: a
  // three-line title under the default 52px margin overflowed into the plot.
  const titleLineCount = title ? splitTextLines(title).length : 0;
  const legend = model.chartSpace.chart.legend;
  const plot = getPlotRect(
    boxWidth,
    boxHeight,
    !!title,
    titleLineCount,
    legend !== undefined,
    legend?.legendPos ?? "r"
  );
  const plotArea = model.chartSpace.chart.plotArea;
  const seriesList = plotArea.plotAreaRegion?.series ?? plotArea.series ?? [];
  const axis = findValueAxis(model);
  // One index of the chart's data, not one per series: `resolveChartExRefs` used to
  // rebuild it on every call, and the region-map paths called it a second time.
  const dataById = new Map(model.chartSpace.chartData.data.map(entry => [entry.id, entry]));

  const series: ChartExSeriesLayer[] = [];
  seriesList.forEach((entry, index) => {
    const nodes = chartExSeriesNodes(model, entry, plot, index, dataById, axis);
    if (nodes) {
      series.push({ nodes });
      return;
    }
    // Only a region map declines to produce plain nodes: it draws as labelled layers,
    // and each layer becomes an entry so the SVG serialiser can wrap them individually.
    const refs = resolveChartExRefs(entry, dataById);
    const values = refs.values;
    const categories =
      refs.categories.length > 0 ? refs.categories : values.map((_, i) => String(i + 1));
    for (const layer of regionMapLayers(values, categories, entry, plot, options.regionMap, axis)) {
      series.push({ nodes: layer.nodes, mode: layer.mode });
    }
  });

  return {
    width: boxWidth,
    height: boxHeight,
    backgroundColor: options.backgroundColor ?? "#fff",
    ...(title ? { title: chartExTitleNode(title, boxWidth) } : {}),
    series,
    legend: legend
      ? chartExLegendNodes(seriesList, boxWidth, boxHeight, titleLineCount, legend.legendPos)
      : []
  };
}

export function renderChartExSvg(model: ChartExModel, options: ChartRenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const plan = chartExPlan(model, options, width, height);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  ];
  if (plan.backgroundColor !== "transparent") {
    // `width="100%"` rather than a node: the background is the document's, not a mark
    // in the picture, and the percentage keeps it correct under any viewBox.
    parts.push(`<rect width="100%" height="100%" fill="${escapeXmlAttr(plan.backgroundColor)}"/>`);
  }
  if (plan.title) {
    parts.push(nodesToSvg([plan.title]));
  }
  for (const layer of plan.series) {
    // `data-region-map-mode` is attached here, at serialisation time, rather than
    // carried through the display list — see {@link ChartExSeriesLayer}.
    parts.push(
      layer.mode === undefined
        ? nodesToSvg(layer.nodes)
        : `<g data-region-map-mode="${escapeXmlAttr(layer.mode)}">${nodesToSvg(layer.nodes)}</g>`
    );
  }
  // Legend last so its swatches sit above the plot.
  parts.push(nodesToSvg(plan.legend));
  parts.push("</svg>");
  return parts.join("");
}

export async function renderChartExPng(
  model: ChartExModel,
  options: ChartRenderOptions = {}
): Promise<Uint8Array> {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  // In a browser, hand the SVG to the platform: its own engine beats the built-in
  // rasteriser on fonts and anti-aliasing. On Node the display list goes straight
  // to pixels, exactly as the classic renderer does.
  //
  // This used to rasterise by re-parsing the SVG this module had just produced,
  // which is the round trip the classic path abandoned — and it lost the same
  // things: a multi-paragraph title arrived as `<tspan>`s the scanner could not
  // place, so all of its lines landed on one baseline, on top of each other.
  if (typeof document !== "undefined" && typeof Image !== "undefined") {
    return renderSvgToPng(renderChartExSvg(model, { ...options, width, height }), {
      width,
      height,
      scale: options.scale,
      dpi: options.dpi
    });
  }
  return rasterizeDrawList(chartExDrawList(model, { ...options, width, height }), {
    width,
    height,
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    ...(options.dpi === undefined ? {} : { dpi: options.dpi })
  });
}

/**
 * The whole chart as one display list.
 *
 * The SVG path cannot use this directly — it has to interleave the
 * `<g data-region-map-mode>` wrappers that report which path drew a region map —
 * but every other backend can, and the raster one does. Both are assembled from the
 * same node builders, so they cannot disagree about the picture.
 */
function chartExDrawList(model: ChartExModel, options: ChartRenderOptions): DrawList {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const plan = chartExPlan(model, options, width, height);
  const children: DrawNode[] = [];
  if (plan.backgroundColor !== "transparent") {
    children.push(
      rectNode({ x: 0, y: 0, width, height }, { fill: cssColour(plan.backgroundColor) })
    );
  }
  if (plan.title) {
    children.push(plan.title);
  }
  for (const layer of plan.series) {
    children.push(...layer.nodes);
  }
  children.push(...plan.legend);
  return { width, height, children };
}

/**
 * Layout IDs whose PDF geometry is expressed in `drawRect` /
 * `drawPath` primitives rather than SVG-specific filters or raster
 * fallbacks. {@link drawChartExPdf} consults this set to decide
 * whether a vector path is available; any layout not listed falls
 * back to the raster pipeline in `chartToPdf`.
 *
 * As of the regionMap port this set covers every ChartEx layout the
 * library currently emits, so vector is the default and raster is
 * only reached when the caller passes `chartToPdf(chart, {
 * forceRaster: true })`.
 *
 * Exported so the `@pdf/excel-bridge` `chartToPdf` helper can make
 * the same decision without reimplementing it.
 */
export const VECTOR_PDF_CHART_EX_LAYOUT_IDS: readonly string[] = [
  "sunburst",
  "treemap",
  "funnel",
  "waterfall",
  "boxWhisker",
  // Histogram shares its `clusteredColumn` rendering path with plain
  // Pareto (minus the cumulative line) — the parser/builder normalises
  // both to `layoutId: "clusteredColumn"`, so this one entry covers
  // both types. The Pareto branch is detected at draw time via
  // `series.layoutPr?.paretoLine`.
  "clusteredColumn",
  // Standalone `paretoLine` layoutId — Excel emits this for the
  // cumulative-percent line component of a paired Pareto chart. The
  // SVG and PDF paths render it as a line-with-points curve rather
  // than falling through to the column default.
  "paretoLine",
  // regionMap now has a full vector path (topology polygons, centroid
  // preview, hex-tile fallback — all three modes ported from the SVG
  // emitter). Callers who need raster output can still opt in via
  // `chartToPdf(chart, { forceRaster: true })`.
  "regionMap"
];

/**
 * True when every series of a ChartEx model has a layoutId that
 * `drawChartExPdf` can render as vector PDF. Used by `chartToPdf` to
 * route the chart to the vector or raster path automatically.
 */
export function canRenderChartExAsVectorPdf(model: ChartExModel): boolean {
  const plotArea = model.chartSpace.chart.plotArea;
  const seriesList = plotArea.plotAreaRegion?.series ?? plotArea.series ?? [];
  if (seriesList.length === 0) {
    return false;
  }
  const supported = new Set(VECTOR_PDF_CHART_EX_LAYOUT_IDS);
  return seriesList.every(s => supported.has(s.layoutId));
}

/**
 * Draw a ChartEx chart as vector content onto a
 * {@link ChartPdfDrawingSurface}. All layout IDs listed in
 * {@link VECTOR_PDF_CHART_EX_LAYOUT_IDS} are supported — the
 * surrounding geometry lives in the "collect" functions shared with
 * the SVG renderer, so the SVG and PDF paths stay equivalent by
 * construction.
 *
 * A layout ID outside that set falls back to a clustered column — the dispatcher's
 * `default` branch — which is why callers should gate on
 * {@link canRenderChartExAsVectorPdf} rather than relying on this function to refuse.
 * It used to close with a `throw` for the unsupported case, but the fallback meant
 * control never reached it: the guard documented an intent the code did not carry out.
 */
export function drawChartExPdf(
  surface: ChartPdfDrawingSurface,
  model: ChartExModel,
  rect: { x: number; y: number; width: number; height: number },
  options: { title?: string; regionMap?: RegionMapDataOptions } = {}
): ChartPdfDrawingSurface {
  // The same plan the SVG and raster paths draw, sized to the destination box. The
  // plot rectangle used to be computed separately here, which is what let the legend
  // cover the data and left the no-legend case on different margins entirely.
  const plan = chartExPlan(
    model,
    {
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.regionMap === undefined ? {} : { regionMap: options.regionMap })
    },
    rect.width,
    rect.height
  );

  // Page background: a light frame. Unlike the SVG background this carries a border,
  // which is what marks the chart's extent on a page that is not its own canvas.
  surface.drawRect({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    fill: { r: 1, g: 1, b: 1 },
    stroke: { r: 0.85, g: 0.85, b: 0.85 }
  });

  // One adapter owns the flip. This used to wrap the page in a hand-written flipping
  // surface and *then* ask the shared adapter not to flip — two implementations of the
  // same reflection, which is how a rotated label or a cubic control point could come
  // out mirrored on one path and not the other.
  const target = createChartPdfDrawSurface(surface, rect.x, rect.y, rect.height);
  if (plan.title) {
    renderNodesToChartPdf(target, [plan.title]);
  }
  for (const layer of plan.series) {
    // A content stream has nowhere to record a region map's mode, so only the nodes
    // carry over; the picture is the same one the SVG path draws.
    renderNodesToChartPdf(target, layer.nodes);
  }
  // Legend last so its swatches sit above the plot, matching the SVG draw order. The
  // vector PDF path used to omit the legend entirely, so an authored `legendPos`
  // appeared in SVG and PNG but never in a PDF.
  renderNodesToChartPdf(target, plan.legend);
  return surface;
}

interface HierarchyNode {
  name: string;
  value: number;
  children: HierarchyNode[];
}

/** Draw display-list nodes onto a target built by {@link chartExPdfTarget}. */
function renderNodesToChartPdf(target: DrawSurface, nodes: readonly DrawNode[]): void {
  for (const node of nodes) {
    renderNode(node, IDENTITY, target);
  }
}

/**
 * Serialise display-list nodes into markup.
 *
 * Every layout is converted, yet the SVG path still assembles fragments rather
 * than serialising one `DrawList` for the whole chart — deliberately. Two things
 * in the output have no representation in a display list: the `<svg>` element
 * itself, and the `<g data-region-map-mode>` wrapper that reports which path drew
 * a region map (see {@link RegionMapLayer}). Modelling either would mean adding a
 * document node and an arbitrary-attribute channel to the IR for the benefit of a
 * single backend. Emitting them here costs one string join and keeps the IR about
 * geometry and paint, which is why this is the shape it settled on rather than a
 * step on the way somewhere else.
 */
function nodesToSvg(nodes: readonly DrawNode[]): string {
  const surface = new SvgSurface();
  for (const node of nodes) {
    renderNode(node, IDENTITY, surface);
  }
  return surface.markup();
}

/**
 * The display list for one ChartEx series.
 *
 * This is the single dispatch point for every layout both backends can express:
 * the SVG and PDF paths call it and then hand the nodes to their own surface, so a
 * layout cannot render differently depending on which output was asked for. It
 * used to be two parallel `switch` statements — one emitting markup, one calling
 * surface methods — which is how the title size, the legend offset and the
 * histogram plot rect came to disagree.
 *
 * Returns `undefined` for `regionMap`, the one layout still served by a
 * per-backend emitter.
 */
function chartExSeriesNodes(
  model: ChartExModel,
  series: ChartExSeries,
  plot: SvgRect,
  seriesIndex: number,
  dataById: ReadonlyMap<number, ChartExDataEntry>,
  axis: ChartExAxis | undefined
): DrawNode[] | undefined {
  const refs = resolveChartExRefs(series, dataById);
  const values = refs.values;
  const categories =
    refs.categories.length > 0 ? refs.categories : values.map((_, i) => String(i + 1));
  switch (series.layoutId) {
    case "funnel":
      return funnelLayoutNodes(values, categories, series, plot);
    case "waterfall":
      return waterfallLayoutNodes(values, categories, series, plot, axis);
    case "clusteredColumn":
      // Both `histogram` and `pareto` live under clusteredColumn after builder
      // normalisation; a single runtime flag distinguishes them.
      return series.layoutPr?.paretoLine
        ? paretoLayoutNodes(values, categories, plot, axis, { drawColumns: true })
        : histogramLayoutNodes(values, series, plot, axis);
    case "paretoLine":
      // A valid layoutId distinct from `clusteredColumn` + `layoutPr.paretoLine`.
      // Excel stores a paired Pareto as two sibling series — a `clusteredColumn`
      // for the bars and a `paretoLine` for the curve — so this variant must emit
      // only the overlay.
      return paretoLayoutNodes(values, categories, plot, axis, { drawColumns: false });
    case "boxWhisker":
      return boxWhiskerLayoutNodes(values, categories, series, plot, axis);
    case "treemap":
      return treemapNodes(
        collectTreemapCells(buildHierarchy(refs.hierarchy, categories, values), plot)
      );
    case "sunburst":
      return sunburstNodes(
        collectSunburstSlices(buildHierarchy(refs.hierarchy, categories, values), plot)
      );
    case "regionMap":
      return undefined;
    default:
      return columnLayoutNodes(values, categories, plot, COLORS[seriesIndex % COLORS.length], axis);
  }
}

function resolveChartExRefs(
  series: ChartExSeries,
  dataById: ReadonlyMap<number, ChartExDataEntry>
): { values: number[]; categories: string[]; hierarchy: string[][] } {
  const entries = (series.dataRefs ?? [])
    .map(ref => (ref.dataId === undefined ? undefined : dataById.get(ref.dataId)))
    .filter((entry): entry is ChartExDataEntry => !!entry);

  // Per ECMA-376 Chart2014 `ST_DimType`, the dimension's `@type`
  // attribute carries its semantic role:
  //   - `"val"` / `"y"` / `"size"` → primary numeric axis
  //   - `"cat"` → categorical (string) axis
  //   - `"x"` → value-axis category (histogram / pareto bin)
  //   - `"from"` / `"to"` → waterfall transitions
  //   - `"classification"` → hierarchical classifier
  //
  // Previously the renderer picked "the first strDim / numDim in
  // declaration order" which happened to work for simple sunburst /
  // treemap layouts but silently mis-routed dimensions whenever
  // Excel authored the data in a different order (common in
  // waterfall and pareto files, where the `type="x"` numDim often
  // precedes the primary `type="val"` one). Honour the dimension
  // type so the numeric payload lands on `values` regardless of
  // declaration order, and keep a "declaration order" fallback for
  // ChartEx files whose dims carry the permissive `"val"` default.
  const pickNumDim = (): number[] => {
    const valDim = entries.find(
      entry => entry.numDim && (entry.numDim.type === "val" || entry.numDim.type === "y")
    );
    if (valDim) {
      return collectChartExNumbers(valDim);
    }
    // No `val`/`y` — fall back to `size` (bubble / ChartEx size
    // dimension) and then to the first numDim in order.
    const sizeDim = entries.find(entry => entry.numDim?.type === "size");
    if (sizeDim) {
      return collectChartExNumbers(sizeDim);
    }
    const first = entries.find(entry => entry.numDim);
    return first ? collectChartExNumbers(first) : [];
  };
  const pickPrimaryCategoryDim = (): string[] => {
    const catDim = entries.find(entry => entry.strDim?.type === "cat");
    if (catDim) {
      return collectChartExStrings(catDim);
    }
    const first = entries.find(entry => entry.strDim);
    return first ? collectChartExStrings(first) : [];
  };
  // Hierarchy = every `strDim` that isn't the primary category axis.
  // Preserves their declaration order so sunburst/treemap rings still
  // stack outward in the author's intent.
  const primaryCatEntry =
    entries.find(entry => entry.strDim?.type === "cat") ?? entries.find(entry => entry.strDim);
  const hierarchy = entries
    .filter(entry => entry.strDim && entry !== primaryCatEntry)
    .map(entry => collectChartExStrings(entry));

  return {
    values: pickNumDim(),
    categories: pickPrimaryCategoryDim(),
    hierarchy
  };
}

function collectChartExStrings(entry: ChartExDataEntry): string[] {
  const levels = entry.strDim?.levels ?? [];
  const first = levels[0];
  if (!first) {
    return [];
  }
  // One densifier, shared with the classic reader. The copy that used to live here
  // sized the array from `max(points.length, ptCount)`, so a category at `idx="3"` in
  // a file that omits `ptCount` sat outside its own array and was dropped.
  const dense = densifySparsePoints<string | undefined, string>(
    first.points,
    first.ptCount,
    undefined,
    raw => (typeof raw === "string" ? raw : undefined)
  );
  // An unaddressed slot keeps its positional name, as it always has.
  return dense.map((value, index) => value ?? String(index + 1));
}

function collectChartExNumbers(entry: ChartExDataEntry): number[] {
  const levels = entry.numDim?.levels ?? [];
  const first = levels[0];
  if (!first) {
    return [];
  }
  // Mirror the classic `collectNumberValues` semantics: sparse slots
  // are gaps, not zeros. Excel omits `<cx:pt>` entries for blank /
  // `#N/A` source cells; the classic renderer encodes those as `NaN`
  // so `valueToY` / bar builders skip them. Previously the ChartEx
  // path filled gaps with `0`, producing phantom zero-value entries
  // that poisoned the data range (waterfall spanning to 0, histogram
  // bars showing at "empty" categories) and diverged from the classic
  // rendering of identical data.
  return densifySparsePoints(first.points, first.ptCount, NaN, raw =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : NaN
  );
}

/** Nodes for a plain clustered-column layout. */
function columnLayoutNodes(
  values: number[],
  categories: string[],
  plot: SvgRect,
  color: string,
  axis?: ChartExAxis
): DrawNode[] {
  return columnNodes(values, categories, plot, color, valueRange(values, axis));
}

/** Nodes for a histogram: bin the values, then draw them as columns. */
function histogramLayoutNodes(
  values: number[],
  series: ChartExSeries,
  plot: SvgRect,
  axis?: ChartExAxis
): DrawNode[] {
  const bins = buildHistogramBins(values, series.layoutPr?.binning);
  return columnLayoutNodes(
    bins.map(bin => bin.count),
    bins.map(bin => bin.label),
    plot,
    COLORS[0],
    axis
  );
}

/**
 * Nodes for a Pareto chart: descending columns plus the cumulative overlay.
 *
 * `drawColumns` is false for a standalone `paretoLine` series, whose bars come
 * from a sibling `clusteredColumn` series — drawing them here would paint a second
 * set of sorted bars on top of the companion's.
 */
function paretoLayoutNodes(
  values: number[],
  categories: string[],
  plot: SvgRect,
  axis?: ChartExAxis,
  options: { drawColumns?: boolean } = {}
): DrawNode[] {
  const { drawColumns = true } = options;
  // Filter non-finite values before sorting: a `NaN` comparator result makes the
  // order implementation-defined, which desyncs the bars from the cumulative
  // curve.
  const sorted = values
    .map((value, index) => ({ value, category: categories[index] ?? String(index + 1) }))
    .filter(item => Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value);
  const sortedValues = sorted.map(item => item.value);
  const nodes: DrawNode[] = [];
  if (drawColumns) {
    nodes.push(
      ...columnLayoutNodes(
        sortedValues,
        sorted.map(item => item.category),
        plot,
        COLORS[0],
        axis
      )
    );
  }
  nodes.push(...paretoOverlayNodes(sortedValues, plot));
  return nodes;
}

/** Nodes for a waterfall: cumulative spans, subtotals, and the connectors. */
function waterfallLayoutNodes(
  values: number[],
  categories: string[],
  series: ChartExSeries,
  plot: SvgRect,
  axis?: ChartExAxis
): DrawNode[] {
  const subtotalIdx = new Set(series.layoutPr?.subtotals?.map(s => s.idx) ?? []);
  let running = 0;
  const spans = values.map((value, i) => {
    // Excel's waterfall convention: a subtotal column spans `0 → running`
    // — it visualises the cumulative sum up to that point, not the
    // scalar value stored at the row. Author convention leaves the
    // subtotal row's numeric value at `0` (the subtotal is derived),
    // so the old `end = value` read `0` and the subtotal bar
    // collapsed to zero height. Worse, `running = end` then reset
    // the running sum, corrupting every subsequent bar.
    if (subtotalIdx.has(i)) {
      const end = running;
      // Keep `running` unchanged — the next bar should start from the
      // same cumulative sum the subtotal displays.
      return { start: 0, end, value: end, total: true, gap: false };
    }
    // `collectChartExNumbers` emits `NaN` for sparse `<cx:pt>` slots
    // (blanks or `#N/A` source cells). Adding NaN into `running`
    // permanently poisons it, collapsing every subsequent bar's height
    // to zero (via `fmt(NaN) → "0"`). Treat a blank slot as a
    // zero-height span at the current running total and flag it as a
    // `gap` so the colour picker routes to neutral grey rather than
    // "increase" green (`value: 0 >= 0` would otherwise paint the gap
    // row identically to a zero-increase row — visually
    // indistinguishable from real data). Leave `running` advancing as
    // if the missing value were `0`; this matches Excel's own behaviour
    // for blank waterfall rows.
    if (!Number.isFinite(value)) {
      return { start: running, end: running, value: 0, total: false, gap: true };
    }
    const start = running;
    const end = running + value;
    running = end;
    return { start, end, value, total: false, gap: false };
  });
  const range = valueRange(
    spans.flatMap(s => [s.start, s.end]),
    axis
  );
  const resolved: WaterfallSpan[] = spans.map(span => ({
    start: span.start,
    end: span.end,
    gap: span.gap,
    colour: span.gap
      ? "#BFBFBF"
      : span.total
        ? shapeFillColor(series.layoutPr?.totalSpPr, COLORS[2])
        : span.value >= 0
          ? shapeFillColor(series.layoutPr?.increaseSpPr, "#70AD47")
          : shapeFillColor(series.layoutPr?.decreaseSpPr, "#C00000")
  }));
  const nodes = waterfallNodes(resolved, categories, plot, range);
  if (series.layoutPr?.connectorLines !== false) {
    nodes.push(...waterfallConnectorNodes(resolved, plot, range));
  }
  return nodes;
}

/** Nodes for a funnel, honouring per-point fill overrides. */
function funnelLayoutNodes(
  values: number[],
  categories: string[],
  series: ChartExSeries,
  plot: SvgRect
): DrawNode[] {
  // Per-point `dataPt/@idx` overrides resolved up front so the hot loop stays
  // O(n). An Excel-authored funnel with individually coloured stages used to
  // render with the preview palette after a round-trip, even though the authored
  // XML survived byte-for-byte.
  const pointFills = new Map<number, string>();
  for (const point of series.dataPt ?? []) {
    if (point.spPr) {
      pointFills.set(point.idx, shapeFillColor(point.spPr, COLORS[point.idx % COLORS.length]));
    }
  }
  return funnelNodes(
    values,
    plot,
    index => pointFills.get(index) ?? COLORS[index % COLORS.length],
    (index, value) =>
      chartExDataLabelText(series, {
        category: categories[index] ?? String(index + 1),
        value,
        seriesName: seriesLabelText(series)
      })
  );
}

/** Nodes for a box-and-whisker chart, one box per category group. */
function boxWhiskerLayoutNodes(
  values: number[],
  categories: string[],
  series: ChartExSeries,
  plot: SvgRect,
  axis?: ChartExAxis
): DrawNode[] {
  const groups =
    categories.length > 0
      ? groupValuesByCategory(values, categories)
      : new Map([["Values", values]]);
  const range = valueRange(Array.from(groups.values()).flat(), axis);
  const method = series.layoutPr?.quartileMethod ?? "exclusive";
  return boxWhiskerNodes(
    Array.from(groups.keys()).map(key => ({
      key,
      stats: boxStats(groups.get(key) ?? [], method)
    })),
    plot,
    range,
    {
      showMeanMarker: series.layoutPr?.showMeanMarker !== false,
      showMeanLine: !!series.layoutPr?.showMeanLine,
      showInnerPoints: !!series.layoutPr?.showInnerPoints,
      showOutlierPoints: series.layoutPr?.showOutlierPoints !== false
    }
  );
}

/**
 * Treemap geometry collector.
 *
 * Returns plain data — rect, colour, optional label — which
 * {@link treemapNodes} turns into a display list. Keeping the layout separate from
 * the drawing is what let the paired SVG and PDF emitters be replaced by one node
 * builder without touching the layout arithmetic.
 *
 * The layout is squarified ({@link squarify}) — tiles close to square, as Excel
 * produces. It was slice-and-dice, which splits the plot along a single axis in one
 * pass and at one level yields full-height strips: a four-node treemap on a wide
 * plot read as a bar chart, and the narrow tiles fell under the label threshold and
 * lost their names.
 *
 * The label threshold (> 40 × 18 pixels) mirrors the historical SVG
 * code; both backends honour it identically so small treemap cells
 * degrade to colour-only the same way everywhere.
 */
export interface TreemapCell {
  rect: SvgRect;
  color: string;
  label: string | undefined;
}

export function collectTreemapCells(root: HierarchyNode, plot: SvgRect): TreemapCell[] {
  const nodes = root.children.length > 0 ? root.children : [{ ...root, name: "Values" }];
  const entries = squarify(nodes, plot);
  // Drop degenerate cells (zero-value nodes produce zero-width or
  // zero-height rects). Without the filter, those rects are still
  // emitted with `stroke="#fff"` — browsers render the stroke on a
  // collapsed rect as a visible 1-pixel line, producing parasitic
  // white seams between otherwise-adjacent coloured tiles. Color
  // palette indices stay aligned with the remaining nodes so
  // neighbouring tiles keep their authored colour mapping.
  return entries
    .filter(entry => entry.rect.width > 0.5 && entry.rect.height > 0.5)
    .map((entry, i) => ({
      rect: entry.rect,
      color: COLORS[i % COLORS.length],
      label: entry.rect.width > 40 && entry.rect.height > 18 ? entry.node.name : undefined
    }));
}

/**
 * Sunburst geometry collector. Recursively walks the hierarchy,
 * emitting one {@link SunburstSlice} per non-root node in the same
 * angular/ring order the SVG renderer has always used, so the two
 * backends stay pixel-equivalent modulo rasterisation.
 *
 * Colour handling follows the original `renderSunburstNode`
 * "increment on every visit" rule so sibling slices and their
 * descendants walk through `COLORS` in the same sequence regardless of
 * which backend is driving.
 */
export interface SunburstSlice {
  cx: number;
  cy: number;
  /** Outer ring radius, always >= `inner`. */
  outer: number;
  /** Inner ring radius; 0 for the innermost ring. */
  inner: number;
  /** Start angle in radians, 0 = +X axis. */
  start: number;
  /** End angle in radians. */
  end: number;
  color: string;
}

export function collectSunburstSlices(root: HierarchyNode, plot: SvgRect): SunburstSlice[] {
  const slices: SunburstSlice[] = [];
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  // `hierarchyDepth(root)` counts the invisible root, but the recursive
  // emitter skips `depth === 0` (the root doesn't draw). The number of
  // *visible* rings is therefore `depth - 1`. Dividing `radius` by
  // `depth` directly left the outermost `1 / depth` of the plot radius
  // blank (leaf slices stopped at `ring * (depth - 1)` instead of
  // reaching `radius`), wasting one full ring of visual space —
  // progressively worse for shallow hierarchies (a single-level tree
  // halved the rendered radius).
  const maxDepth = Math.max(1, hierarchyDepth(root) - 1);
  const radius = Math.min(plot.width, plot.height) / 2.25;
  // Seed `colorIndex = -1` so the root's "consumed" palette slot (which
  // the recursive emitter reserves via `colorIndex + 1` pre-increment)
  // lands on index `0`. The old `colorIndex = 0` made the root eat
  // `COLORS[0]`, then its first visible child drew at `COLORS[1]` —
  // every sunburst started with orange instead of the accent-1 blue
  // that every other ChartEx type uses.
  collectSunburstSlicesRecursive(slices, root, cx, cy, 0, Math.PI * 2, 0, maxDepth, radius, -1);
  return slices;
}

function collectSunburstSlicesRecursive(
  out: SunburstSlice[],
  node: HierarchyNode,
  cx: number,
  cy: number,
  startAngle: number,
  endAngle: number,
  depth: number,
  maxDepth: number,
  radius: number,
  colorIndex: number
): number {
  const ring = radius / Math.max(1, maxDepth);
  let nextColorIndex = colorIndex;
  if (depth > 0) {
    out.push({
      cx,
      cy,
      outer: ring * depth,
      inner: ring * (depth - 1),
      start: startAngle,
      end: endAngle,
      color: COLORS[colorIndex % COLORS.length]
    });
  }
  const total = node.children.reduce((sum, c) => sum + Math.max(0, c.value), 0) || 1;
  let angle = startAngle;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    // Snap the last child to `endAngle` exactly. Summing N floating
    // fractions of a range almost never reproduces the range bound
    // (IEEE-754 drift on the order of 1e-13 per step), and on deep
    // hierarchies with many siblings that drift accumulates until the
    // outermost ring's sweep slips below the `2π - 1e-9` full-circle
    // guard downstream — the ring then renders as a degenerate
    // near-invisible arc instead of the closing slice.
    const next =
      i === node.children.length - 1
        ? endAngle
        : angle + (Math.max(0, child.value) / total) * (endAngle - startAngle);
    nextColorIndex = collectSunburstSlicesRecursive(
      out,
      child,
      cx,
      cy,
      angle,
      next,
      depth + 1,
      maxDepth,
      radius,
      nextColorIndex + 1
    );
    angle = next;
  }
  return nextColorIndex;
}

/**
 * The chart title, as one node.
 *
 * Both backends used to build this themselves — SVG assembling `<tspan>`s with a
 * relative `dy`, PDF looping `drawText` per paragraph — which is how they came to
 * disagree on the font size and baseline in the first place.
 */
function chartExTitleNode(title: string, width: number): DrawNode {
  return multilineTextNode(
    width / 2,
    CHART_EX_TITLE_BASELINE,
    splitTextLines(title).map(run => run.text),
    CHART_EX_TITLE_FONT_SIZE,
    "#222222",
    "middle",
    CHART_EX_TITLE_FONT_SIZE * TEXT_LINE_HEIGHT_EM
  );
}

/** The legend: a swatch and a label per entry, from the shared layout. */
function chartExLegendNodes(
  series: ChartExSeries[],
  width: number,
  height: number,
  titleLines: number,
  legendPos: "b" | "l" | "r" | "t" | "tr" | undefined
): DrawNode[] {
  const nodes: DrawNode[] = [];
  for (const entry of layoutChartExLegend(series, width, height, titleLines, legendPos)) {
    nodes.push(
      rectNode(
        {
          x: entry.swatchX,
          y: entry.swatchY,
          width: entry.swatchSize,
          height: entry.swatchSize
        },
        { fill: cssColour(entry.color) }
      )
    );
    nodes.push(
      textNode(
        entry.labelX,
        entry.labelBaselineY,
        entry.label,
        CHART_EX_LEGEND_FONT_SIZE,
        CHART_EX_LEGEND_COLOR,
        "start"
      )
    );
  }
  return nodes;
}

/** The map's rounded background panel. */
function regionMapPanelNode(plot: SvgRect): DrawNode {
  return rectNode(
    plot,
    { fill: cssColour("#F7FBFF"), stroke: cssColour("#C7DFF2"), strokeWidth: 1 },
    14
  );
}

/**
 * One labelled group of region-map output.
 *
 * `mode` records which rendering path produced the nodes — the real TopoJSON
 * outline, the built-in centroid preview, or the hex-tile fallback. That is not
 * decoration: it is the only channel through which the library reports whether a
 * caller's topology actually matched their categories, and the matcher options
 * (`match: "id"`, `match: ["property:name_zh", …]`) are unverifiable without it.
 *
 * It stays out of the display list deliberately. The display list describes
 * geometry and paint, and a mode is neither — it is a fact about a decision the
 * renderer made. The SVG path turns it into a `data-region-map-mode` attribute on a
 * wrapping `<g>` at serialisation time, which is where SVG-only metadata belongs,
 * the same reasoning that keeps filters in `svgDefs` / `svgFilterId`. A content
 * stream has nowhere to put it, so the PDF path just draws the nodes.
 */
interface RegionMapLayer {
  readonly mode: string;
  readonly nodes: DrawNode[];
}

/**
 * The region map, as labelled layers.
 *
 * Replaces a pair of emitters — one assembling markup, one calling surface methods
 * — which had already drifted: the SVG panel had rounded corners and the PDF panel
 * did not.
 */
function regionMapLayers(
  values: number[],
  categories: string[],
  series: ChartExSeries,
  plot: SvgRect,
  mapOptions?: RegionMapDataOptions,
  axis?: ChartExAxis
): RegionMapLayer[] {
  const range = valueRange(values, axis);

  // Path A: the caller supplied a TopoJSON dataset. Fall through to the centroid
  // preview if anything goes wrong — invalid topology, no matches, unsupported
  // geometry — so a failed match still shows something rather than an empty chart.
  if (mapOptions?.topology) {
    const nodes = tryRegionMapTopologyNodes(values, categories, series, plot, range, mapOptions);
    if (nodes) {
      return [{ mode: "topojson", nodes }];
    }
  }

  const records = values.map((value, i) => ({
    value,
    label: categories[i] ?? String(i + 1),
    coord: lookupRegionCoordinate(categories[i] ?? String(i + 1))
  }));
  const known = records.filter(
    (record): record is { value: number; label: string; coord: RegionCoordinate } => !!record.coord
  );
  if (known.length === 0) {
    return [{ mode: "tile-fallback", nodes: regionMapTileFallbackNodes(records, range, plot) }];
  }

  const nodes: DrawNode[] = [regionMapPanelNode(plot), ...regionMapGraticuleNodes(plot)];
  const labelMode = series.layoutPr?.regionLabels ?? "bestFit";
  const projection = series.layoutPr?.projection ?? "miller";
  // Frame to the data, the same way the TopoJSON branch does. Only the records with
  // a finite value are drawn, so only those may influence the framing.
  const extent = matchExtentToPlot(
    fitRegionExtent(
      known
        .filter(record => Number.isFinite(record.value))
        .map(record => projectLonLatRaw(record.coord.lon, record.coord.lat, projection))
    ),
    plot
  );
  for (const record of known) {
    const projected = projectLonLatToPlot(
      record.coord.lon,
      record.coord.lat,
      projection,
      plot,
      extent
    );
    // Skip non-finite values: `NaN` would propagate into both the radius (drawing
    // an invisible zero-radius dot) and the colour interpolation. Clamp `t` so an
    // out-of-range value still gets a defined colour, matching the topology branch.
    if (!Number.isFinite(record.value)) {
      continue;
    }
    const t = clamp01((record.value - range.min) / Math.max(1e-9, range.max - range.min));
    const radius = 6 + Math.sqrt(t) * 14;
    // The old markup carried `opacity="0.92"` on the element. The display list has
    // no element-level opacity, so it becomes an alpha on each paint. That is a
    // faithful translation of the intent but not of the compositing: element
    // opacity flattens the shape and then fades it, so the white ring's overlap
    // with its own fill ends up marginally lighter than fading each paint
    // separately does. The band is under a pixel wide and differs by at most
    // 15/255, and the fill itself is unchanged — see the `draw` section of
    // AGENTS.md for why closing that gap is not worth offscreen compositing in
    // three backends.
    nodes.push({
      kind: "ellipse",
      cx: projected.x,
      cy: projected.y,
      rx: radius,
      ry: radius,
      paint: {
        fill: { ...cssColour(interpolateColor("#D9EAF7", "#2F75B5", t)), a: 0.92 },
        stroke: { ...cssColour("#FFFFFF"), a: 0.92 },
        strokeWidth: 1.5
      }
    });
    if (labelMode === "showAll" || (labelMode === "bestFit" && radius >= 9)) {
      nodes.push(textNode(projected.x, projected.y + 3, record.label, 9, "#1F3B53", "middle"));
    }
  }

  const layers: RegionMapLayer[] = [{ mode: "geographic-preview", nodes }];
  const unknown = records.filter(record => !record.coord);
  if (unknown.length > 0) {
    const fallbackHeight = Math.min(52, plot.height * 0.25);
    layers.push({
      mode: "unmatched",
      nodes: regionMapTileFallbackNodes(unknown, range, {
        x: plot.x + 8,
        y: plot.y + plot.height - fallbackHeight - 8,
        width: plot.width - 16,
        height: fallbackHeight
      })
    });
  }
  return layers;
}

/**
 * Render the region map using a user-supplied TopoJSON topology.
 *
 * Returns `true` when at least one feature was drawn so the caller
 * skips the centroid-dot fallback. Returns `false` on any failure
 * (topology invalid, geometry not found, zero matches) so the caller
 * can degrade gracefully to the built-in preview.
 *
 * Matching policy: case-insensitive + trimmed comparison, consistent
 * with `normaliseLabel` used by the centroid table. Matches every
 * feature once — unmatched features are drawn as a neutral-fill
 * outline so the world map provides context even for the regions
 * the author didn't supply data for.
 */
function tryRegionMapTopologyNodes(
  values: number[],
  categories: string[],
  series: ChartExSeries,
  plot: SvgRect,
  range: { min: number; max: number },
  mapOptions: RegionMapDataOptions
): DrawNode[] | undefined {
  let features: ReturnType<typeof resolveTopologyObject>;
  try {
    features = resolveTopologyObject(mapOptions.topology as TopologyLike, mapOptions.objectName);
  } catch {
    return undefined;
  }
  if (features.length === 0) {
    return undefined;
  }

  // Normalise the `match` option into an ordered rule list. A single
  // rule stays functionally identical to the pre-matchers behaviour;
  // an array lets callers express locale-aware fall-backs such as
  // `["property:name_zh", "property:name", "id"]` without writing
  // custom code per workbook.
  const matchRules: RegionMapMatchRule[] = (() => {
    const raw = mapOptions.match ?? "id";
    return Array.isArray(raw) ? (raw.length > 0 ? raw : ["id"]) : [raw];
  })();
  const candidateKeys = (f: (typeof features)[number]): string[] => {
    const keys: string[] = [];
    for (const rule of matchRules) {
      const raw = rule.startsWith("property:")
        ? (f.properties?.[rule.slice(9)] as string | number | undefined)
        : (f.id as string | number | undefined);
      if (raw !== undefined && raw !== null) {
        keys.push(String(raw).trim().toLowerCase());
      }
    }
    return keys;
  };

  // Build value map: label → value.
  const valueByLabel = new Map<string, number>();
  categories.forEach((label, i) => {
    const norm = normaliseLabel(label);
    if (norm) {
      valueByLabel.set(norm, values[i]);
    }
  });
  if (valueByLabel.size === 0) {
    return undefined;
  }

  // Determine data extents in the projected unit square so we can
  // scale to the plot rectangle. Compute once over all feature
  // coordinates the user supplied — this keeps the map centred even
  // when the TopoJSON covers a bounding box larger than the matched
  // countries.
  const projection = mapOptions.projection ?? series.layoutPr?.projection ?? "miller";
  const rawExtent = computeProjectionExtent(features, projection);
  if (!rawExtent) {
    return undefined;
  }
  // Same correction the centroid preview needs: without it a world map is stretched
  // to whatever shape the panel happens to be.
  const extent = matchExtentToPlot(rawExtent, plot);

  // Buffer into a local array and return it only once a feature has matched. If
  // nothing matches, the caller falls through to the centroid preview and must not
  // find a half-drawn world outline underneath it, or the composite shows both
  // layers.
  const buffer: DrawNode[] = [regionMapPanelNode(plot)];

  // Resolve each feature against the rule list once and cache both the
  // winning key and its value, so the fill loop and the label loop
  // below don't re-scan the rules (which would be O(rules × features × 2)
  // for world-atlas scale topologies).
  const resolvedMatch = new Map<
    (typeof features)[number],
    { key: string; value: number } | undefined
  >();
  for (const feature of features) {
    const keys = candidateKeys(feature);
    let hit: { key: string; value: number } | undefined;
    for (const key of keys) {
      const value = valueByLabel.get(key);
      if (value !== undefined) {
        hit = { key, value };
        break;
      }
    }
    resolvedMatch.set(feature, hit);
  }

  // Compute per-feature fill: matched features get the value-scaled
  // colour, unmatched get a neutral base so the world still appears.
  const stroke = mapOptions.strokeColor ?? "#FFFFFF";
  let matchedCount = 0;
  for (const feature of features) {
    const match = resolvedMatch.get(feature);
    const fill = match
      ? (() => {
          matchedCount++;
          const t = (match.value - range.min) / Math.max(1e-9, range.max - range.min);
          return interpolateColor("#D9EAF7", "#2F75B5", Math.max(0, Math.min(1, t)));
        })()
      : "#E9EEF3";
    const commands = featureToPathCommands(feature.rings, projection, plot, extent);
    if (commands) {
      buffer.push({
        kind: "path",
        commands,
        paint: {
          fill: cssColour(fill),
          stroke: cssColour(stroke),
          strokeWidth: 0.5
        }
      });
    }
  }

  // No feature matched any author-supplied category. Abandon the
  // buffered world outline — the caller will draw the centroid
  // preview on a clean plot area instead of layering it over our
  // partial output.
  if (matchedCount === 0) {
    return undefined;
  }

  // Build a reverse lookup (normalised category → original label) once
  // so label emission can find the author-supplied spelling regardless
  // of which matcher rule produced the hit.
  const labelByKey = new Map<string, string>();
  categories.forEach(label => {
    const norm = normaliseLabel(label);
    if (norm) {
      labelByKey.set(norm, label);
    }
  });

  // Labels for matched features — place at the first ring's centroid.
  const labelMode = series.layoutPr?.regionLabels ?? "bestFit";
  if (labelMode === "showAll" || labelMode === "bestFit") {
    for (const feature of features) {
      const match = resolvedMatch.get(feature);
      if (!match || feature.rings.length === 0) {
        continue;
      }
      const centroidLonLat = ringCentroid(feature.rings[0]);
      if (!centroidLonLat) {
        continue;
      }
      const projected = projectLonLatToPlot(
        centroidLonLat[0],
        centroidLonLat[1],
        projection,
        plot,
        extent
      );
      const originalLabel =
        labelByKey.get(match.key) ??
        (typeof feature.id === "string" ? feature.id : String(feature.id ?? ""));
      buffer.push(textNode(projected.x, projected.y + 3, originalLabel, 9, "#1F3B53", "middle"));
    }
  }

  // At least one feature matched, so claim the chart area.
  return buffer;
}

/**
 * Unit-square → plot-rect projection shared by the topology
 * renderer. Uses the same projection table as `projectRegionCoordinate`
 * but feeds the result through the per-dataset extent so the bundle
 * of features is centred in the plot regardless of the topology's
 * coordinate extent.
 */
function projectLonLatToPlot(
  lon: number,
  lat: number,
  projection: NonNullable<RegionMapDataOptions["projection"]>,
  plot: SvgRect,
  extent: { minX: number; maxX: number; minY: number; maxY: number }
): { x: number; y: number } {
  const raw = projectLonLatRaw(lon, lat, projection);
  const nx =
    extent.maxX === extent.minX ? 0.5 : (raw.x - extent.minX) / (extent.maxX - extent.minX);
  const ny =
    extent.maxY === extent.minY ? 0.5 : (raw.y - extent.minY) / (extent.maxY - extent.minY);
  return {
    x: plot.x + 14 + nx * Math.max(1, plot.width - 28),
    y: plot.y + 14 + ny * Math.max(1, plot.height - 28)
  };
}

/**
 * Project a single (lon, lat) pair into the projection's raw
 * coordinate space (not yet plot-normalised). The four projections
 * mirror `projectRegionCoordinate`'s formulas — duplicated here
 * because the existing function already applies plot padding, which
 * we need to defer until after the per-dataset extent is known.
 */
function projectLonLatRaw(
  lon: number,
  lat: number,
  projection: NonNullable<RegionMapDataOptions["projection"]>
): { x: number; y: number } {
  const clampedLon = Math.max(-180, Math.min(180, lon));
  // The ±85° clamp only applies to projections with a Mercator-style
  // singularity at the poles (`log(tan(π/4 ± π/2)) → ∞`). Albers,
  // Robinson, and plain equirectangular are all finite at ±90°, so
  // clamping their input destroys 5° of polar data for no reason —
  // Antarctica and high-latitude research stations silently flatten
  // onto the `±85°` parallel when rendered under those projections.
  const clampedLat =
    projection === "mercator" || projection === "miller"
      ? Math.max(-MERCATOR_LAT_CLAMP_DEG, Math.min(MERCATOR_LAT_CLAMP_DEG, lat))
      : Math.max(-90, Math.min(90, lat));
  switch (projection) {
    case "mercator": {
      const rad = (clampedLat * Math.PI) / 180;
      return {
        x: clampedLon / 360,
        y: -Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI)
      };
    }
    case "miller": {
      const rad = (clampedLat * Math.PI) / 180;
      return {
        x: clampedLon / 360,
        y: -(1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * rad))) / (2 * Math.PI)
      };
    }
    case "albers": {
      const { rawX, rawY } = rawAlbers(clampedLon, clampedLat);
      return { x: rawX, y: rawY };
    }
    case "robinson": {
      const { nx, ny } = projectRobinson(clampedLon, clampedLat);
      // projectRobinson returns 0..1; subtract 0.5 to centre.
      return { x: nx - 0.5, y: ny - 0.5 };
    }
    default: {
      return { x: clampedLon / 360, y: -clampedLat / 180 };
    }
  }
}

/**
 * Derive the min/max projected extent across every ring in the
 * provided feature list. Used to normalise the topology's coordinate
 * space into the plot rectangle without distortion.
 */
function computeProjectionExtent(
  features: ReturnType<typeof resolveTopologyObject>,
  projection: NonNullable<RegionMapDataOptions["projection"]>
): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const feature of features) {
    for (const ring of feature.rings) {
      for (const [lon, lat] of ring) {
        const { x, y } = projectLonLatRaw(lon, lat, projection);
        if (x < minX) {
          minX = x;
        }
        if (x > maxX) {
          maxX = x;
        }
        if (y < minY) {
          minY = y;
        }
        if (y > maxY) {
          maxY = y;
        }
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return undefined;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * A feature's rings as path commands.
 *
 * One builder for every backend. This used to be two — `featureToSvgPath`
 * assembling a `d` string and `featureToPdfPathOps` assembling operators — from
 * the same projected coordinates, which is two chances to project differently.
 */
function featureToPathCommands(
  rings: ResolvedRing[],
  projection: NonNullable<RegionMapDataOptions["projection"]>,
  plot: SvgRect,
  extent: { minX: number; maxX: number; minY: number; maxY: number }
): DrawPathCommand[] | undefined {
  const commands: DrawPathCommand[] = [];
  for (const ring of rings) {
    if (ring.length < 2) {
      continue;
    }
    const points = ring.map(([lon, lat]) =>
      projectLonLatToPlot(lon, lat, projection, plot, extent)
    );
    commands.push({ op: "move", x: points[0].x, y: points[0].y });
    for (let index = 1; index < points.length; index++) {
      commands.push({ op: "line", x: points[index].x, y: points[index].y });
    }
    commands.push({ op: "close" });
  }
  return commands.length > 0 ? commands : undefined;
}

/**
 * Geometric (area-weighted) centroid of a polygon ring in lon/lat
 * space. Uses the shoelace formula (Bourke 1988) so vertex density
 * does not bias the result — a country with a densely sampled
 * coastline and a sparse inland border still has its label centred
 * on the polygon's visual mass. The previous implementation returned
 * the vertex mean, which for long-coastline countries (Norway,
 * Chile, Indonesia) sat visibly off-centre.
 *
 * Falls back to the vertex mean when the ring's signed area rounds
 * to zero (degenerate / self-intersecting polygons where the
 * shoelace formula is undefined).
 */
function ringCentroid(ring: ResolvedRing): [number, number] | undefined {
  const n = ring.length;
  if (n === 0) {
    return undefined;
  }
  if (n < 3) {
    // A 1- or 2-point ring has no interior. Return the vertex mean;
    // callers use this centroid purely for label placement.
    let sumX = 0;
    let sumY = 0;
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
    }
    return [sumX / n, sumY / n];
  }
  let signedArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea *= 0.5;
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) < 1e-12) {
    // Degenerate ring (zero area / numerical collapse) — fall back to
    // the vertex mean so we still return *something* for the label.
    let sumX = 0;
    let sumY = 0;
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
    }
    return [sumX / n, sumY / n];
  }
  const scale = 1 / (6 * signedArea);
  return [cx * scale, cy * scale];
}

/** Lowercase + trim label to match the case-insensitive lookup policy. */
function normaliseLabel(label: string): string {
  return label.trim().toLowerCase();
}

interface RegionCoordinate {
  lon: number;
  lat: number;
}

const REGION_COORDINATES: Record<string, RegionCoordinate> = {
  // Approximate country centroids used for regionMap preview rendering.
  // Coordinates are degrees longitude (east positive) / latitude (north
  // positive) of the country's geographic centre. The exact centroid
  // method doesn't matter for a preview-grade renderer — a dot anywhere
  // inside the country is visually acceptable.
  //
  // Coverage targets the ISO-3166-1 short names and common aliases
  // Excel users feed regionMap; synonyms (uk → united kingdom,
  // usa → united states, etc.) are added so the lookup is case- and
  // form-insensitive.
  afghanistan: { lon: 66, lat: 34 },
  albania: { lon: 20, lat: 41 },
  algeria: { lon: 3, lat: 28 },
  angola: { lon: 17, lat: -12 },
  argentina: { lon: -64, lat: -34 },
  armenia: { lon: 45, lat: 40 },
  australia: { lon: 134, lat: -25 },
  austria: { lon: 14, lat: 47 },
  azerbaijan: { lon: 47, lat: 40 },
  bahamas: { lon: -78, lat: 24 },
  bahrain: { lon: 50, lat: 26 },
  bangladesh: { lon: 90, lat: 24 },
  belarus: { lon: 28, lat: 53 },
  belgium: { lon: 4, lat: 50 },
  belize: { lon: -88, lat: 17 },
  benin: { lon: 2, lat: 9 },
  bhutan: { lon: 90, lat: 27 },
  bolivia: { lon: -64, lat: -16 },
  "bosnia and herzegovina": { lon: 18, lat: 44 },
  botswana: { lon: 24, lat: -22 },
  brazil: { lon: -52, lat: -10 },
  brunei: { lon: 114, lat: 4 },
  bulgaria: { lon: 25, lat: 43 },
  "burkina faso": { lon: -2, lat: 12 },
  burundi: { lon: 30, lat: -3 },
  cambodia: { lon: 105, lat: 13 },
  cameroon: { lon: 12, lat: 5 },
  canada: { lon: -106, lat: 56 },
  "central african republic": { lon: 21, lat: 7 },
  chad: { lon: 19, lat: 15 },
  chile: { lon: -71, lat: -30 },
  china: { lon: 104, lat: 35 },
  colombia: { lon: -72, lat: 4 },
  "costa rica": { lon: -84, lat: 10 },
  croatia: { lon: 16, lat: 45 },
  cuba: { lon: -78, lat: 22 },
  cyprus: { lon: 33, lat: 35 },
  "czech republic": { lon: 15, lat: 50 },
  czechia: { lon: 15, lat: 50 },
  "democratic republic of the congo": { lon: 23, lat: -2 },
  denmark: { lon: 10, lat: 56 },
  djibouti: { lon: 43, lat: 12 },
  "dominican republic": { lon: -70, lat: 19 },
  ecuador: { lon: -79, lat: -2 },
  egypt: { lon: 30, lat: 26 },
  "el salvador": { lon: -89, lat: 14 },
  "equatorial guinea": { lon: 10, lat: 2 },
  eritrea: { lon: 39, lat: 15 },
  estonia: { lon: 26, lat: 59 },
  ethiopia: { lon: 40, lat: 9 },
  fiji: { lon: 178, lat: -18 },
  finland: { lon: 26, lat: 64 },
  france: { lon: 2, lat: 46 },
  gabon: { lon: 11, lat: -1 },
  gambia: { lon: -15, lat: 13 },
  georgia: { lon: 43, lat: 42 },
  germany: { lon: 10, lat: 51 },
  ghana: { lon: -2, lat: 8 },
  greece: { lon: 22, lat: 39 },
  greenland: { lon: -42, lat: 72 },
  guatemala: { lon: -90, lat: 15 },
  guinea: { lon: -10, lat: 11 },
  "guinea-bissau": { lon: -15, lat: 12 },
  guyana: { lon: -58, lat: 5 },
  haiti: { lon: -72, lat: 19 },
  honduras: { lon: -86, lat: 15 },
  "hong kong": { lon: 114, lat: 22 },
  hungary: { lon: 20, lat: 47 },
  iceland: { lon: -19, lat: 65 },
  india: { lon: 78, lat: 22 },
  indonesia: { lon: 118, lat: -2 },
  iran: { lon: 53, lat: 32 },
  iraq: { lon: 44, lat: 33 },
  ireland: { lon: -8, lat: 53 },
  israel: { lon: 35, lat: 31 },
  italy: { lon: 12, lat: 43 },
  "ivory coast": { lon: -5, lat: 7 },
  "côte d’ivoire": { lon: -5, lat: 7 },
  jamaica: { lon: -77, lat: 18 },
  japan: { lon: 138, lat: 37 },
  jordan: { lon: 36, lat: 31 },
  kazakhstan: { lon: 68, lat: 48 },
  kenya: { lon: 38, lat: 0 },
  kuwait: { lon: 47, lat: 29 },
  kyrgyzstan: { lon: 75, lat: 41 },
  laos: { lon: 104, lat: 18 },
  latvia: { lon: 25, lat: 56 },
  lebanon: { lon: 36, lat: 33 },
  lesotho: { lon: 28, lat: -29 },
  liberia: { lon: -9, lat: 6 },
  libya: { lon: 17, lat: 27 },
  liechtenstein: { lon: 9, lat: 47 },
  lithuania: { lon: 24, lat: 56 },
  luxembourg: { lon: 6, lat: 49 },
  macedonia: { lon: 21, lat: 41 },
  "north macedonia": { lon: 21, lat: 41 },
  madagascar: { lon: 47, lat: -20 },
  malawi: { lon: 34, lat: -13 },
  malaysia: { lon: 102, lat: 4 },
  mali: { lon: -4, lat: 17 },
  malta: { lon: 14, lat: 35 },
  mauritania: { lon: -11, lat: 20 },
  mauritius: { lon: 57, lat: -20 },
  mexico: { lon: -102, lat: 23 },
  moldova: { lon: 28, lat: 47 },
  monaco: { lon: 7, lat: 43 },
  mongolia: { lon: 104, lat: 46 },
  montenegro: { lon: 19, lat: 42 },
  morocco: { lon: -7, lat: 32 },
  mozambique: { lon: 35, lat: -18 },
  myanmar: { lon: 96, lat: 21 },
  burma: { lon: 96, lat: 21 },
  namibia: { lon: 18, lat: -22 },
  nepal: { lon: 84, lat: 28 },
  netherlands: { lon: 5, lat: 52 },
  "new zealand": { lon: 174, lat: -41 },
  nicaragua: { lon: -85, lat: 13 },
  niger: { lon: 8, lat: 17 },
  nigeria: { lon: 8, lat: 10 },
  "north korea": { lon: 127, lat: 40 },
  norway: { lon: 10, lat: 62 },
  oman: { lon: 57, lat: 21 },
  pakistan: { lon: 70, lat: 30 },
  palestine: { lon: 35, lat: 32 },
  panama: { lon: -80, lat: 9 },
  "papua new guinea": { lon: 144, lat: -6 },
  paraguay: { lon: -58, lat: -23 },
  peru: { lon: -75, lat: -10 },
  philippines: { lon: 122, lat: 13 },
  poland: { lon: 20, lat: 52 },
  portugal: { lon: -8, lat: 40 },
  qatar: { lon: 51, lat: 25 },
  "republic of the congo": { lon: 15, lat: -1 },
  romania: { lon: 25, lat: 46 },
  russia: { lon: 100, lat: 60 },
  rwanda: { lon: 30, lat: -2 },
  "saudi arabia": { lon: 45, lat: 24 },
  senegal: { lon: -15, lat: 14 },
  serbia: { lon: 21, lat: 44 },
  "sierra leone": { lon: -12, lat: 8 },
  singapore: { lon: 104, lat: 1 },
  slovakia: { lon: 19, lat: 49 },
  slovenia: { lon: 15, lat: 46 },
  somalia: { lon: 46, lat: 5 },
  "south africa": { lon: 25, lat: -29 },
  "south korea": { lon: 128, lat: 36 },
  "south sudan": { lon: 30, lat: 7 },
  spain: { lon: -4, lat: 40 },
  "sri lanka": { lon: 81, lat: 7 },
  sudan: { lon: 30, lat: 15 },
  suriname: { lon: -56, lat: 4 },
  sweden: { lon: 15, lat: 62 },
  switzerland: { lon: 8, lat: 47 },
  syria: { lon: 38, lat: 35 },
  taiwan: { lon: 121, lat: 24 },
  tajikistan: { lon: 71, lat: 39 },
  tanzania: { lon: 35, lat: -6 },
  thailand: { lon: 101, lat: 15 },
  togo: { lon: 1, lat: 8 },
  "trinidad and tobago": { lon: -61, lat: 11 },
  tunisia: { lon: 9, lat: 34 },
  turkey: { lon: 35, lat: 39 },
  turkmenistan: { lon: 59, lat: 40 },
  uganda: { lon: 32, lat: 1 },
  ukraine: { lon: 32, lat: 49 },
  "united arab emirates": { lon: 54, lat: 24 },
  uae: { lon: 54, lat: 24 },
  "united kingdom": { lon: -2, lat: 54 },
  uk: { lon: -2, lat: 54 },
  britain: { lon: -2, lat: 54 },
  "great britain": { lon: -2, lat: 54 },
  "united states": { lon: -98, lat: 39 },
  "united states of america": { lon: -98, lat: 39 },
  usa: { lon: -98, lat: 39 },
  us: { lon: -98, lat: 39 },
  uruguay: { lon: -56, lat: -33 },
  uzbekistan: { lon: 64, lat: 41 },
  venezuela: { lon: -66, lat: 8 },
  vietnam: { lon: 108, lat: 16 },
  yemen: { lon: 48, lat: 15 },
  zambia: { lon: 28, lat: -14 },
  zimbabwe: { lon: 30, lat: -19 }
};

function lookupRegionCoordinate(label: string): RegionCoordinate | undefined {
  // Consult the pre-normalised lookup table so queries and keys go
  // through the identical `normalizeRegionLabel` transform. The old
  // `REGION_COORDINATES[normalizeRegionLabel(label)]` path applied the
  // strip-the/republic-of regex to the *query* only, leaving keys like
  // `"democratic republic of the congo"` unreachable via their own
  // canonical name — `lookup("Democratic Republic of the Congo")`
  // normalised to `"democratic congo"` and missed the key.
  return NORMALISED_REGION_COORDINATES.get(normalizeRegionLabel(label));
}

function normalizeRegionLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\b(the|republic of)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Pre-normalised view of {@link REGION_COORDINATES}. Built once at module
 * load so runtime lookups don't re-normalise keys on every query.
 */
const NORMALISED_REGION_COORDINATES: Map<string, RegionCoordinate> = new Map(
  Object.entries(REGION_COORDINATES).map(([k, v]) => [normalizeRegionLabel(k), v])
);

/** The map graticule: three meridians and two parallels, inset from the frame. */
function regionMapGraticuleNodes(plot: SvgRect): DrawNode[] {
  const paint: DrawPaint = { stroke: cssColour("#E5F0FA"), strokeWidth: 1 };
  const nodes: DrawNode[] = [];
  for (let i = 1; i < 4; i++) {
    const x = plot.x + (plot.width * i) / 4;
    nodes.push(lineNode(x, plot.y + 8, x, plot.y + plot.height - 8, paint));
  }
  for (let i = 1; i < 3; i++) {
    const y = plot.y + (plot.height * i) / 3;
    nodes.push(lineNode(plot.x + 8, y, plot.x + plot.width - 8, y, paint));
  }
  return nodes;
}

// Mercator projection clamps latitude to `±MERCATOR_LAT_CLAMP_DEG`
// to avoid the singularity at the poles (where `log(tan(π/4 + π/2)) → ∞`).
// 85° is the de facto standard used by Web Mercator / EPSG:3857 tile
// services; clamping to a smaller value would visibly shear circumpolar
// regions. Two separate code paths in this file (`projectLonLatRaw`
// and `projectRegionCoordinate`) previously used different values (85
// vs 84), producing slightly different output for the same topology —
// the centroid path and the polygon path rendered at different zoom
// levels. Unify here.
const MERCATOR_LAT_CLAMP_DEG = 85;

/**
 * Widen a projected extent until its shape matches the plot's, so the placement step
 * cannot stretch the geography.
 *
 * {@link projectLonLatToPlot} maps each axis of the extent onto the corresponding
 * side of the plot independently. That only leaves the projection undistorted if the
 * extent and the plot have the same aspect ratio; otherwise a degree of longitude
 * covers more pixels than a degree of latitude and the map is squashed. Expanding the
 * shorter axis — never cropping the longer one — keeps every point in frame.
 */
function matchExtentToPlot(
  extent: { minX: number; maxX: number; minY: number; maxY: number },
  plot: SvgRect
): { minX: number; maxX: number; minY: number; maxY: number } {
  const availableWidth = Math.max(1, plot.width - 28);
  const availableHeight = Math.max(1, plot.height - 28);
  const spanX = extent.maxX - extent.minX;
  const spanY = extent.maxY - extent.minY;
  if (spanX <= 0 || spanY <= 0) {
    return extent;
  }
  const target = availableWidth / availableHeight;
  const current = spanX / spanY;
  if (Math.abs(current - target) < 1e-9) {
    return extent;
  }
  if (current < target) {
    const widened = spanY * target;
    const pad = (widened - spanX) / 2;
    return { ...extent, minX: extent.minX - pad, maxX: extent.maxX + pad };
  }
  const heightened = spanX / target;
  const pad = (heightened - spanY) / 2;
  return { ...extent, minY: extent.minY - pad, maxY: extent.maxY + pad };
}

/**
 * Fit a set of projected points into an extent centred on them.
 *
 * The centroid preview used to map the *whole world* onto the panel, so a chart of
 * four American countries drew them overlapping in one corner while the rest of the
 * panel stayed empty and the labels were illegible. The TopoJSON branch already
 * framed to its data through `computeProjectionExtent`, so the two also disagreed
 * about framing.
 *
 * The extent is padded for the markers, which are drawn *around* their point and
 * would otherwise be clipped at the edges, and floored at a minimum span so a single
 * point or a tight cluster keeps some context instead of zooming to absurdity. Each
 * axis is sized from its own data; {@link matchExtentToPlot} then widens whichever is
 * proportionally short, which is what keeps the projection undistorted while still
 * using the panel.
 */
function fitRegionExtent(points: readonly { x: number; y: number }[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    // Nothing to frame; fall back to the whole world in raw projection units.
    return { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 };
  }
  // `projectLonLatRaw` spans roughly [-0.5, 0.5], so a twentieth of that is ~18° of
  // longitude — enough context around a lone point for it to read as a map.
  const minimumSpan = 0.05;
  const axis = (low: number, high: number): { low: number; high: number } => {
    const centre = (low + high) / 2;
    // A fifth of the span as padding leaves room for the markers, which are drawn
    // around their point rather than inside it.
    const half = Math.max(minimumSpan, ((high - low) / 2) * 1.2);
    return { low: centre - half, high: centre + half };
  };
  const horizontal = axis(minX, maxX);
  const vertical = axis(minY, maxY);
  return {
    minX: horizontal.low,
    maxX: horizontal.high,
    minY: vertical.low,
    maxY: vertical.high
  };
}

/**
 * Albers Equal-Area Conic projection, normalised to the 0..1 unit square.
 *
 * Uses world-wide standard parallels (φ1=20°, φ2=60°) centred on the
 * equator and prime meridian — the same defaults `proj4` and `d3-geo`
 * apply when no explicit parallels are supplied. The returned `nx`/`ny`
 * are normalised by the world extent so the 19-country centroid table
 * lands inside the plot rectangle for every canvas size.
 *
 * Formulas follow Snyder, "Map Projections — A Working Manual", USGS
 * Professional Paper 1395 §14. Equal-area means the cone coefficient
 * `n` is the same for every latitude, so we compute it once at module
 * load.
 */
const ALBERS_PHI1 = (20 * Math.PI) / 180;
const ALBERS_PHI2 = (60 * Math.PI) / 180;
const ALBERS_N = (Math.sin(ALBERS_PHI1) + Math.sin(ALBERS_PHI2)) / 2;
const ALBERS_C =
  Math.cos(ALBERS_PHI1) * Math.cos(ALBERS_PHI1) + 2 * ALBERS_N * Math.sin(ALBERS_PHI1);
const ALBERS_RHO0 = Math.sqrt(ALBERS_C) / ALBERS_N;
function rawAlbers(lon: number, lat: number): { rawX: number; rawY: number } {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const rho = Math.sqrt(Math.max(0, ALBERS_C - 2 * ALBERS_N * Math.sin(phi))) / ALBERS_N;
  const theta = ALBERS_N * lambda;
  return {
    rawX: rho * Math.sin(theta),
    rawY: ALBERS_RHO0 - rho * Math.cos(theta)
  };
}

/**
 * Robinson projection — a pseudocylindrical compromise projection whose
 * X and Y scaling factors are defined by a look-up table at 5° latitude
 * intervals with linear interpolation between entries.
 *
 * The factor tables below come from Robinson's original 1974 publication
 * (as reproduced in Snyder & Voxland, "An Album of Map Projections",
 * USGS Professional Paper 1453, Table 34). `PLEN` is the length of a
 * parallel relative to the equator; `PDFE` is the perpendicular distance
 * from the equator. Values are symmetric about the equator, so the
 * implementation looks up `|φ|` and mirrors the Y sign.
 */
const ROBINSON_PLEN = [
  1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986,
  0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322
];
const ROBINSON_PDFE = [
  0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903,
  0.8435, 0.8936, 0.9394, 0.9761, 1
];

function robinsonFactors(absLatDeg: number): { plen: number; pdfe: number } {
  // Table is indexed by lat / 5°. Use linear interpolation between the
  // two surrounding rows for non-multiple latitudes.
  const idxFloat = Math.min(ROBINSON_PLEN.length - 1, absLatDeg / 5);
  const lo = Math.floor(idxFloat);
  const hi = Math.min(ROBINSON_PLEN.length - 1, lo + 1);
  const t = idxFloat - lo;
  return {
    plen: ROBINSON_PLEN[lo] + (ROBINSON_PLEN[hi] - ROBINSON_PLEN[lo]) * t,
    pdfe: ROBINSON_PDFE[lo] + (ROBINSON_PDFE[hi] - ROBINSON_PDFE[lo]) * t
  };
}

function projectRobinson(lon: number, lat: number): { nx: number; ny: number } {
  const { plen, pdfe } = robinsonFactors(Math.abs(lat));
  const sign = lat >= 0 ? -1 : 1; // SVG y grows downward
  // Robinson's conventional aspect ratio is plen_equator : 2 * pdfe_pole
  //   = 1 : 0.5072, so the normalised Y uses that half-height.
  const nx = 0.5 + (lon / 180) * plen * 0.5;
  const ny = 0.5 + sign * pdfe * 0.5072 * 0.5;
  return { nx, ny };
}

/**
 * The hex-tile fallback: a value-coloured hexagon per record, laid out in a grid.
 *
 * Used both on its own (no category resolved to a coordinate) and as a sub-panel
 * listing the records the geographic preview could not place.
 */
function regionMapTileFallbackNodes(
  records: Array<{ value: number; label: string }>,
  range: { min: number; max: number },
  plot: SvgRect
): DrawNode[] {
  const count = Math.max(1, records.length);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = plot.width / cols;
  const cellH = plot.height / rows;
  const radius = Math.min(cellW, cellH) * 0.38;
  const nodes: DrawNode[] = [];
  records.forEach((record, i) => {
    if (!Number.isFinite(record.value)) {
      return;
    }
    const cx = plot.x + (i % cols) * cellW + cellW / 2;
    const cy = plot.y + Math.floor(i / cols) * cellH + cellH / 2;
    const t = clamp01((record.value - range.min) / Math.max(1e-9, range.max - range.min));
    nodes.push(
      polygonNode(hexagonPoints(cx, cy, radius), {
        fill: cssColour(interpolateColor("#D9EAF7", "#2F75B5", t)),
        stroke: cssColour("#FFFFFF"),
        strokeWidth: 1
      })
    );
    if (cellW > 34 && cellH > 22) {
      nodes.push(textNode(cx, cy + 3, record.label, 9, "#1F3B53", "middle"));
    }
  });
  return nodes;
}

function buildHistogramBins(
  values: number[],
  binning: NonNullable<ChartExSeries["layoutPr"]>["binning"] | undefined
): Array<{ label: string; count: number }> {
  // `collectChartExNumbers` encodes blank / `#N/A` source cells as
  // `NaN` (matching the classic renderer's gap semantics). NaN
  // propagates through `sort((a,b) => a-b)` (the comparator returns
  // `NaN`, which the sort treats as "no swap", leaving the NaNs
  // wherever they landed) — so `sorted[0]` or `sorted[N-1]` can be
  // `NaN`, producing `rawSize = NaN` and throwing downstream. Strip
  // non-finite values up front: a histogram of "blanks mixed with
  // numbers" means "bin the numbers, ignore the blanks", matching
  // Excel's own behaviour.
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) {
    return [];
  }
  const sorted = finite.slice().sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (binning?.binType === "categories") {
    const counts = new Map<string, number>();
    for (const value of finite) {
      const key = String(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts, ([label, count]) => ({ label, count }));
  }
  const binCount =
    binning?.binCount ??
    (binning?.binType === "binCount" ? 10 : Math.ceil(Math.sqrt(finite.length)));
  // Auto bin width. The previous `Math.max(1, …)` floor collapsed
  // fractional datasets (percentages / probabilities / 0-1 ranges)
  // into a single bin — e.g. `[0.1..0.9]` with `binCount=3` produced
  // `rawSize=1` and a single `[0.1, 1.1]` bin. Scale the bin width to
  // the data range instead, but fall back to 1 when the data collapses
  // to a single point (`max === min`) so the `> 0` guard below doesn't
  // fire for a legitimate all-identical dataset.
  const span = max - min;
  const rawSize = binning?.binSize ?? (span > 0 ? span / Math.max(1, binCount) : 1);
  // Guard against a caller-supplied or computation-produced
  // non-positive bin width. Previously the `for` loop below never
  // advanced when `rawSize <= 0`, degenerating into a 1000-iteration
  // spin (stopped only by the `bins.length > 1000` safety valve) that
  // wasted CPU and produced a chart full of zero-width "bins". Fail
  // loud with a descriptive error instead — this catches user mistakes
  // (e.g. `binning: { binSize: 0 }`) and edge cases where `max === min`
  // with `binCount === 0`.
  if (!(rawSize > 0) || !Number.isFinite(rawSize)) {
    throw new ChartOptionsError(
      `Histogram bin size must be a positive finite number; got ${rawSize}.`
    );
  }
  const start = binning?.underflow ?? min;
  const end = binning?.overflow ?? max;
  const bins: Array<{ low: number; high: number; label: string; count: number }> = [];
  if (binning?.underflow !== undefined) {
    bins.push({
      low: -Infinity,
      high: binning.underflow,
      label: `<=${formatNumber(binning.underflow)}`,
      count: 0
    });
  }
  // Cap the bin count at a sane limit. Excel's own histogram UI
  // accepts up to ~1000 bins; going higher produces unreadable output
  // anyway. `HISTOGRAM_BIN_CAP` used to `break` silently, truncating
  // the last bin's upper bound and mis-positioning the overflow bin
  // — users with a tiny `rawSize` relative to `end - start` got a
  // chart with no visual clue that data was cut off. Fail loud with
  // `ChartOptionsError` instead; callers with legitimately wide
  // ranges should reduce their bin count or widen `rawSize`.
  const HISTOGRAM_BIN_CAP = 1000;
  const expectedBinCount = Math.ceil((end - start) / rawSize);
  if (expectedBinCount > HISTOGRAM_BIN_CAP) {
    throw new ChartOptionsError(
      `Histogram would produce ${expectedBinCount} bins with binSize=${rawSize} over [${start}, ${end}]; ` +
        `the renderer caps at ${HISTOGRAM_BIN_CAP}. Widen the bin size or narrow the data range.`
    );
  }
  // Emit exactly enough bins to cover `[start, end]`. Compute the bin
  // count up front and iterate by index so repeated `low += rawSize`
  // IEEE-754 drift doesn't produce a spurious extra bin — e.g.
  // `start=0.05, end=0.95, rawSize=0.1` previously drifted past `end`
  // because the `0.1`s accumulate (summing ten of them lands at
  // `0.9999999999999999`, not `1.0`), emitting an 11th empty bin that
  // trailed the chart at the right edge. `Math.round` the count so
  // we stop at the last bin whose UPPER edge is still `<= end`;
  // anything beyond `end` is captured by `bins[bins.length - 1]`'s
  // upper fence or the overflow bin.
  const normalSpan = end - start;
  // `Math.round(normalSpan / rawSize)` handles the exact-multiple case
  // (e.g. `span=10, rawSize=2` → 5 bins, not 4 from `Math.floor`
  // after `9.999…`). Adding `8*EPSILON*|span|` is a drift cushion that
  // pulls a `9.999…99` computation up to 10 before rounding.
  const expectedNormalBins = Math.max(
    1,
    Math.round((normalSpan + Number.EPSILON * 8 * normalSpan) / rawSize)
  );
  for (let i = 0; i < expectedNormalBins; i++) {
    const low = start + i * rawSize;
    const high = i === expectedNormalBins - 1 ? end : start + (i + 1) * rawSize;
    bins.push({ low, high, label: `${formatNumber(low)}-${formatNumber(high)}`, count: 0 });
  }
  if (binning?.overflow !== undefined) {
    bins.push({
      low: binning.overflow,
      high: Infinity,
      label: `>${formatNumber(binning.overflow)}`,
      count: 0
    });
  }
  // Degenerate case: `start === end` (all input values identical, or
  // caller set `underflow === overflow`) means the generator loop
  // emitted zero "normal" bins. Without a fallback, the counting loop
  // below would try to write `bins[-1].count++` and throw. Guarantee
  // at least one bin exists by synthesising a unit-width bucket at
  // `start`; this matches Excel's own single-bin output for all-
  // identical data.
  if (bins.length === 0) {
    bins.push({
      low: start,
      high: start + rawSize,
      label: `${formatNumber(start)}-${formatNumber(start + rawSize)}`,
      count: 0
    });
  }
  const closedLeft = binning?.intervalClosed === "l";
  // Index of the lowest "normal" bin (first bin after an optional
  // underflow sentinel). Values equal to the axis minimum need to
  // land here for right-closed intervals — `value > b.low` would
  // otherwise drop them into the fallback. Mirrors Excel's own
  // "values less than or equal to this bin" semantics where the
  // lowest bin has no effective lower bound.
  const firstNormalBinIdx = binning?.underflow !== undefined ? 1 : 0;
  // Similarly, the highest "normal" bin must accept values equal to
  // the axis maximum under left-closed intervals (`value < b.high`
  // otherwise excludes them).
  const lastNormalBinIdx = bins.length - (binning?.overflow !== undefined ? 2 : 1);
  // Iterate over the NaN-filtered array so sparse blanks don't leak
  // into the `bins[bins.length - 1]` fallback at the loop tail.
  for (const value of finite) {
    const bin =
      bins.find((b, idx) => {
        const lowHit = closedLeft
          ? value >= b.low
          : idx === firstNormalBinIdx
            ? value >= b.low
            : value > b.low;
        const highHit = closedLeft
          ? idx === lastNormalBinIdx
            ? value <= b.high
            : value < b.high
          : value <= b.high;
        return lowHit && highHit;
      }) ?? bins[bins.length - 1];
    bin.count++;
  }
  return bins.map(({ label, count }) => ({ label, count }));
}

function groupValuesByCategory(values: number[], categories: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  values.forEach((value, i) => {
    const key = categories[i] ?? "Values";
    const list = groups.get(key) ?? [];
    list.push(value);
    groups.set(key, list);
  });
  return groups;
}

function boxStats(values: number[], method: "inclusive" | "exclusive") {
  const sorted = values
    .slice()
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const safe = sorted.length > 0 ? sorted : [0];
  const q1 = percentile(safe, 0.25, method);
  const median = percentile(safe, 0.5, method);
  const q3 = percentile(safe, 0.75, method);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const nonOutliers = safe.filter(v => v >= lowFence && v <= highFence);
  const outliers = safe.filter(v => v < lowFence || v > highFence);
  // Whisker bounds are the smallest and largest *non-outlier* values.
  // Use `reduce` instead of `Math.min(...arr)` / `Math.max(...arr)` so the
  // implementation is safe for large samples (the spread form blows the
  // JS call stack past ~100k elements).
  const whiskerSource = nonOutliers.length ? nonOutliers : safe;
  const low = whiskerSource.reduce((acc, v) => (v < acc ? v : acc), whiskerSource[0]);
  const high = whiskerSource.reduce((acc, v) => (v > acc ? v : acc), whiskerSource[0]);
  return {
    q1,
    median,
    q3,
    low,
    high,
    mean: safe.reduce((sum, v) => sum + v, 0) / safe.length,
    outliers,
    // `nonOutliers` — every finite sample within `[lowFence, highFence]`.
    // Exposed so renderers that draw "inner points" do not double-plot
    // outliers as both a filled inner-point dot AND a hollow outlier
    // ring. Excel's convention: inner points are individual non-outlier
    // observations; outlier points are the `|v - median| > 1.5·IQR`
    // samples, and the two overlays must be disjoint.
    nonOutliers
  };
}

function percentile(values: number[], p: number, method: "inclusive" | "exclusive"): number {
  if (values.length === 0) {
    return NaN;
  }
  if (values.length === 1) {
    return values[0];
  }
  // `rank` is 1-indexed per the convention used by NIST / Excel's
  // `PERCENTILE.INC` / `PERCENTILE.EXC`. Clamp to `[1, N]` so the
  // interpolation `fraction = rank - lower` stays in `[0, 1]`.
  // Previously `rank` could fall below 1 for the exclusive method with
  // small `p` (e.g. N=2, p=0.25, exclusive: rank = 3*0.25 = 0.75 → lower
  // clamped to 1 but fraction = −0.25, producing a point lower than
  // both source values — wrong sign). The clamp here matches Excel's
  // behaviour of returning the minimum / maximum for out-of-band `p`.
  const rawRank = method === "inclusive" ? 1 + (values.length - 1) * p : (values.length + 1) * p;
  const rank = Math.max(1, Math.min(values.length, rawRank));
  const lower = Math.max(1, Math.floor(rank));
  const upper = Math.min(values.length, Math.ceil(rank));
  const fraction = rank - lower;
  return values[lower - 1] + (values[upper - 1] - values[lower - 1]) * fraction;
}

function buildHierarchy(levels: string[][], categories: string[], values: number[]): HierarchyNode {
  const root: HierarchyNode = { name: "root", value: 0, children: [] };
  values.forEach((value, i) => {
    let node = root;
    // Preserve explicit empty-string labels (`""` is a legitimate
    // node name in Excel's hierarchy data — "Unassigned" / "Blank"
    // category rolls up under a visible empty slice). The previous
    // `filter(Boolean)` dropped every level where the user had
    // intentionally left the label empty, collapsing those points into
    // the wrong parent. Also filter `null`/`undefined` which do mean
    // "no hierarchy level at this depth".
    const path = [
      ...levels.map(level => level[i]).filter(v => v !== undefined && v !== null),
      categories[i] ?? String(i + 1)
    ];
    // Clamp negative contributions to zero at insert time. Sunburst /
    // treemap layouts use angular / areal sweep proportional to
    // `node.value`; a mix of positive and negative values would
    // otherwise net out to a small (or zero) parent total, producing
    // a ring with zero angular span. NaN / Infinity likewise
    // degrade to zero so they don't poison the sum.
    const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
    for (const name of path) {
      let child = node.children.find(c => c.name === name);
      if (!child) {
        child = { name, value: 0, children: [] };
        node.children.push(child);
      }
      child.value += safeValue;
      node = child;
    }
    root.value += safeValue;
  });
  return root;
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
 *
 * Lays each level out in rows, choosing at every step whether adding the next node
 * to the current row improves its worst aspect ratio or whether the row should be
 * closed and a new one started along the other axis. The result is tiles that are
 * close to square, which is what makes a treemap readable — area is easy to compare
 * between squares and hard between slivers.
 *
 * This replaced a slice-and-dice layout, which split the plot along a single axis
 * in one pass. That is proportional and stable, but at one level it produces
 * full-height strips: a four-node treemap on a wide plot read as a bar chart, and
 * the narrower tiles fell below the label threshold and lost their names.
 */
function squarify(
  nodes: HierarchyNode[],
  rect: SvgRect
): Array<{ node: HierarchyNode; rect: SvgRect }> {
  const result: Array<{ node: HierarchyNode; rect: SvgRect }> = [];
  layoutRows(
    nodes.filter(node => Math.max(0, node.value) > 0),
    rect,
    result
  );
  // Recurse into children, inset so the parent's tile stays visible around them.
  // Collected in a second pass so a child never sees a rect that a later row of its
  // own level would have changed.
  const parents = result.filter(
    entry => entry.node.children.length > 0 && entry.rect.width > 18 && entry.rect.height > 18
  );
  for (const parent of parents) {
    // Push one at a time rather than spreading: `result.push(...children)` passes
    // each element as a separate argument, which throws `RangeError: Maximum call
    // stack size exceeded` past ~100k entries. Every per-array fold in this file
    // takes the same defensive shape.
    for (const child of squarify(parent.node.children, insetRect(parent.rect, 4))) {
      result.push(child);
    }
  }
  return result;
}

/** Place one level's nodes as squarified rows inside `rect`. */
function layoutRows(
  nodes: readonly HierarchyNode[],
  rect: SvgRect,
  out: Array<{ node: HierarchyNode; rect: SvgRect }>
): void {
  if (nodes.length === 0 || rect.width <= 0 || rect.height <= 0) {
    return;
  }
  // Largest first: the algorithm's aspect-ratio heuristic assumes it, and a
  // descending order also puts the biggest tile in a predictable corner.
  const ordered = [...nodes].sort((a, b) => Math.max(0, b.value) - Math.max(0, a.value));
  const total = ordered.reduce((sum, node) => sum + Math.max(0, node.value), 0);
  if (total <= 0) {
    return;
  }
  // Work in area units so a node's value maps directly to pixels.
  const areaScale = (rect.width * rect.height) / total;
  let free = { ...rect };
  let index = 0;
  while (index < ordered.length) {
    const shorter = Math.min(free.width, free.height);
    const row: HierarchyNode[] = [ordered[index]];
    let rowArea = Math.max(0, ordered[index].value) * areaScale;
    index++;
    // Extend the row while doing so improves its worst aspect ratio.
    while (index < ordered.length) {
      const nextArea = Math.max(0, ordered[index].value) * areaScale;
      if (
        worstAspect(row, rowArea, shorter, areaScale) <=
        worstAspect([...row, ordered[index]], rowArea + nextArea, shorter, areaScale)
      ) {
        break;
      }
      row.push(ordered[index]);
      rowArea += nextArea;
      index++;
    }
    // The row occupies a band across the shorter side; lay its members out along it.
    const thickness = shorter > 0 ? rowArea / shorter : 0;
    const alongWidth = free.width < free.height;
    let offset = 0;
    for (const node of row) {
      const area = Math.max(0, node.value) * areaScale;
      const extent = thickness > 0 ? area / thickness : 0;
      out.push({
        node,
        rect: alongWidth
          ? { x: free.x + offset, y: free.y, width: extent, height: thickness }
          : { x: free.x, y: free.y + offset, width: thickness, height: extent }
      });
      offset += extent;
    }
    free = alongWidth
      ? { x: free.x, y: free.y + thickness, width: free.width, height: free.height - thickness }
      : { x: free.x + thickness, y: free.y, width: free.width - thickness, height: free.height };
    if (free.width <= 0 || free.height <= 0) {
      break;
    }
  }
}

/** The worst (largest) aspect ratio among a candidate row's tiles. */
function worstAspect(
  row: readonly HierarchyNode[],
  rowArea: number,
  shorter: number,
  areaScale: number
): number {
  if (rowArea <= 0 || shorter <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const thickness = rowArea / shorter;
  let worst = 0;
  for (const node of row) {
    const area = Math.max(0, node.value) * areaScale;
    if (area <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const extent = area / thickness;
    worst = Math.max(worst, Math.max(thickness / extent, extent / thickness));
  }
  return worst;
}

function hierarchyDepth(node: HierarchyNode): number {
  // Fold via a loop rather than `Math.max(0, ...arr)` spread — for
  // pathologically-wide hierarchies (>~100k siblings) the spread blows
  // the JS call stack. Every other per-array fold in this file
  // (valueRange, boxStats, funnel max) takes this shape; keep the
  // defensive style consistent here too.
  let maxChild = 0;
  for (const child of node.children) {
    const d = hierarchyDepth(child);
    if (d > maxChild) {
      maxChild = d;
    }
  }
  return 1 + maxChild;
}

/**
 * Resolve what a data label should read, or `undefined` when it is hidden.
 *
 * `ChartExSeries.dataLabels` was accepted by the builder, serialised and parsed,
 * but no renderer ever read it: every layout hard-coded its own choice. The most
 * visible consequence was the funnel, whose model default is `value: true`
 * (matching a freshly inserted Excel chart) while the renderer drew the category
 * name — so SVG, PNG and PDF agreed with each other and disagreed with the model
 * they were rendering.
 *
 * Parts are emitted in Excel's order — series name, category, value — joined with
 * the authored `separator`.
 */
function chartExDataLabelText(
  series: ChartExSeries,
  datum: { category?: string; value?: number; seriesName?: string }
): string | undefined {
  const labels = series.dataLabels;
  if (!labels) {
    return undefined;
  }
  const visibility = labels.visibility ?? {};
  const parts: string[] = [];
  if (visibility.seriesName && datum.seriesName) {
    parts.push(datum.seriesName);
  }
  if (visibility.categoryName && datum.category !== undefined) {
    parts.push(datum.category);
  }
  if (visibility.value && datum.value !== undefined && Number.isFinite(datum.value)) {
    parts.push(formatNumber(datum.value));
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(labels.separator ?? ", ");
}

/** One resolved legend entry: a colour swatch and its label baseline. */
interface ChartExLegendEntry {
  readonly swatchX: number;
  readonly swatchY: number;
  readonly swatchSize: number;
  readonly labelX: number;
  readonly labelBaselineY: number;
  readonly label: string;
  readonly color: string;
}

/**
 * Margins the legend layout assumes are free.
 *
 * Reserved by `getPlotRect`, which both backends now call, so a legend cannot be
 * placed over the plot. Named constants because the two must not drift apart
 * again.
 */
const CHART_EX_LEGEND_LEFT_INSET = 58;
const CHART_EX_LEGEND_RIGHT_INSET = 128;
const CHART_EX_LEGEND_BOTTOM_INSET = 46;

/**
 * Margins used when there is no legend: enough to keep axis labels off the edge,
 * without the reservation a legend would need.
 */
const NO_LEGEND_INSET = 12;
/**
 * Room the value-axis labels need on the left, whatever the legend does.
 *
 * They are drawn at `plot.x - 8` and right-anchored, so a four-digit label at 10 units
 * reaches about 30 px back from the plot edge. The legend's own reservation is larger and
 * subsumes this when it sits on the left.
 */
const AXIS_LABEL_INSET = 44;
/** Title size and baseline, shared by both backends. */
const CHART_EX_TITLE_FONT_SIZE = 18;
const CHART_EX_TITLE_BASELINE = 26;
/**
 * Vertical room each title paragraph past the first takes up.
 *
 * The 1.2 em step at the 18-unit title font is 21.6; this rounds up so the plot
 * never touches a descender. Everything that has to clear the title block —
 * {@link getPlotRect} and the top legend row in {@link layoutChartExLegend} —
 * shifts by this same amount, because a title that grew by a line has to push
 * both of them down together.
 */
const CHART_EX_TITLE_LINE_STEP = 22;
const NO_LEGEND_BOTTOM_INSET = 24;

/** Font size the legend labels are drawn at, in points/user units. */
const CHART_EX_LEGEND_FONT_SIZE = 10;
/** Legend label colour. */
const CHART_EX_LEGEND_COLOR = "#555";

/**
 * Place the legend entries for a ChartEx preview.
 *
 * Layout is computed once and shared by the SVG and PDF backends. It used to
 * live inline in the SVG emitter, which is why the PDF renderer had no legend at
 * all: `legendPos` was honoured in SVG and PNG but silently dropped from every
 * vector PDF. Returning geometry rather than markup is what lets both backends
 * agree without a second copy of the arithmetic.
 *
 * Honours the authored `legendPos`; unknown positions fall back to the right
 * side. Budget: ~18 px per row for vertical stacks, ~96 px per inline item for
 * horizontal ones.
 */
type ChartExLegendPosition = "b" | "l" | "r" | "t" | "tr";

function layoutChartExLegend(
  series: ChartExSeries[],
  width: number,
  height: number,
  titleLines: number,
  legendPos: "b" | "l" | "r" | "t" | "tr" | undefined
): ChartExLegendEntry[] {
  const pos = legendPos ?? "r";
  const hasTitle = titleLines > 0;
  const extraTitleLines = Math.max(0, titleLines - 1);
  // Read the same reservation `getPlotRect` uses, so the legend sits in the band left
  // for it rather than at a hard-coded offset that stops matching once the margins
  // scale down on a small canvas.
  const insets = chartExInsets(width, height, hasTitle, titleLines, true, pos);
  const rowHeight = 18;
  const swatchSize = 10;
  const hGap = 8; // gap between swatch and text
  const itemPadding = 14; // gap between horizontal entries
  const estItemWidth = (label: string): number =>
    swatchSize + hGap + Math.max(28, label.length * 6) + itemPadding;
  // A series caption can be multi-paragraph, but a legend row is
  // single-line by construction — flatten it rather than let each backend
  // mishandle the newline in its own way.
  const labels = series.map((s, i) => singleLineLabel(seriesLabelText(s) ?? `Series ${i + 1}`));
  const colorOf = (i: number): string => COLORS[i % COLORS.length];

  if (pos === "b" || pos === "t") {
    // Horizontal row. `b` sits at the bottom of the canvas, `t` immediately
    // below the chart title (or near the top when there is none).
    const totalW = labels.reduce((sum, l) => sum + estItemWidth(l), 0) - itemPadding;
    const startX = Math.max(6, (width - totalW) / 2);
    // `t` has to clear the plot, whose top edge `getPlotRect` puts at 52 once
    // there is a title. Sitting at 44 left the 10px swatch overlapping it by
    // two pixels — invisible in the SVG preview until the PDF backend started
    // using the same layout, but wrong in both.
    //
    // A title paragraph past the first pushes this row down by the same step the
    // plot moves. Keying off `hasTitle` alone put the row at a fixed 40 while the
    // second title line sat at baseline 47.6, so a two-line title was drawn
    // through the legend, and a three-line one had the legend wedged between its
    // paragraphs.
    const baseY =
      pos === "b" ? height - 22 : hasTitle ? 40 + extraTitleLines * CHART_EX_TITLE_LINE_STEP : 10;
    const entries: ChartExLegendEntry[] = [];
    let offsetX = startX;
    labels.forEach((label, i) => {
      entries.push({
        swatchX: offsetX,
        swatchY: baseY,
        swatchSize,
        labelX: offsetX + swatchSize + hGap,
        labelBaselineY: baseY + swatchSize - 1,
        label,
        color: colorOf(i)
      });
      offsetX += estItemWidth(label);
    });
    return entries;
  }

  if (pos === "l") {
    // Left vertical stack, inside the left margin; `getPlotRect` leaves
    // `plot.x` at 58 so a 10 px swatch plus a ~40 px label fits.
    // 8 px in from the edge, with the label a swatch-and-gap further along.
    const swatchX = Math.min(8, insets.left * 0.14);
    return labels.map((label, i) => {
      const y = (hasTitle ? 44 : 20) + i * rowHeight;
      return {
        swatchX,
        swatchY: y,
        swatchSize,
        labelX: swatchX + swatchSize + 4,
        labelBaselineY: y + 9,
        label,
        color: colorOf(i)
      };
    });
  }

  // Right / top-right vertical stack. `tr` lifts the stack up near the title
  // baseline; plain `r` sits slightly below it. Both land inside the 128 px
  // right margin from `getPlotRect`.
  const baseY = pos === "tr" ? (hasTitle ? 44 : 16) : hasTitle ? 44 : 20;
  // 12 px inside the reserved band, which is where `width - 116` put it while the
  // reservation was a fixed 128.
  const swatchX = width - insets.right + Math.min(12, insets.right * 0.09);
  return labels.map((label, i) => {
    const y = baseY + i * rowHeight;
    return {
      swatchX,
      swatchY: y,
      swatchSize,
      labelX: swatchX + swatchSize + hGap,
      labelBaselineY: y + 9,
      label,
      color: colorOf(i)
    };
  });
}

/**
 * Extract a plain-text caption from a {@link ChartExSeries.tx} in the
 * canonical preference order: `rich` (walk paragraphs → runs) →
 * `strRef` (the formula string itself, since cached points live on
 * the series-data side of the model not on `tx`) → `value`. Mirrors
 * `Chart.title` resolution on the classic side.
 */
function seriesLabelText(s: ChartExSeries): string | undefined {
  const tx = s.tx;
  if (!tx) {
    return undefined;
  }
  if (tx.rich) {
    return tx.rich.paragraphs.map(p => (p.runs ?? []).map(r => r.text).join("")).join("\n");
  }
  if (tx.value !== undefined) {
    return tx.value;
  }
  if (tx.strRef) {
    // Prefer the cached resolved value when the parser captured one;
    // it's what Excel shows in the legend before formula evaluation.
    // Fall back to the raw formula string so the series remains
    // visually identifiable when no cache was stored.
    if (typeof tx.strRef === "object") {
      return tx.strRef.cached ?? tx.strRef.formula;
    }
    return tx.strRef;
  }
  return undefined;
}

/**
 * The margins reserved around the plot.
 *
 * One source for both {@link getPlotRect} and {@link layoutChartExLegend}: the plot's
 * edge and the legend's position are two readings of the same reservation, and when
 * they were written as separate constants — 128 reserved on the right, the swatch
 * placed at `width - 116` — scaling one without the other put the legend inside the
 * plot.
 *
 * The reservations are absolute pixel counts sized for a comfortable chart, and on a
 * small one they swallow it: 58 + 128 of a 240-wide canvas left 54 px of plot, and a
 * 260-wide one was down to 74. They scale down together once they would claim more
 * than their share.
 */
function chartExInsets(
  width: number,
  height: number,
  hasTitle: boolean,
  titleLines: number,
  hasLegend: boolean,
  legendPos: ChartExLegendPosition = "r"
): { left: number; right: number; top: number; bottom: number } {
  // Only the side the legend is on has to make room for it. Reserving all four meant a
  // top or bottom legend still gave up 58 px on the left and 128 on the right — around
  // 40 % of the width of a 460-wide chart, for a legend that is nowhere near either edge.
  const wantsLeft = hasLegend && legendPos === "l";
  const wantsRight = hasLegend && (legendPos === "r" || legendPos === "tr");
  const wantsBottom = hasLegend && legendPos === "b";
  // The axis labels are drawn at `plot.x - 8`, right-anchored, so the left margin has a
  // floor whatever the legend does: without it the numbers run off the canvas.
  const left = wantsLeft ? CHART_EX_LEGEND_LEFT_INSET : AXIS_LABEL_INSET;
  const right = wantsRight ? CHART_EX_LEGEND_RIGHT_INSET : NO_LEGEND_INSET;
  const claimed = left + right;
  const budget = width * 0.55;
  const factor = claimed > budget ? budget / claimed : 1;
  const extraLines = Math.max(0, titleLines - 1);
  return {
    left: left * factor,
    right: right * factor,
    top: hasTitle ? 52 + extraLines * CHART_EX_TITLE_LINE_STEP : 24,
    bottom: Math.min(
      wantsBottom ? CHART_EX_LEGEND_BOTTOM_INSET : NO_LEGEND_BOTTOM_INSET,
      height * 0.25
    )
  };
}

function getPlotRect(
  width: number,
  height: number,
  hasTitle: boolean,
  titleLines = 1,
  hasLegend = true,
  legendPos: ChartExLegendPosition = "r"
): SvgRect {
  const insets = chartExInsets(width, height, hasTitle, titleLines, hasLegend, legendPos);
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(10, width - insets.left - insets.right),
    height: Math.max(10, height - insets.top - insets.bottom)
  };
}

function valueRange(values: number[], axis?: ChartExAxis): { min: number; max: number } {
  // Honour author-supplied bounds first. `valScaling.min` / `valScaling.max`
  // (Chart2014 `CT_AxisUnit`) let the user pin the axis regardless of the
  // observed data range; the renderer previously ignored them, so a
  // histogram / pareto / waterfall / boxWhisker authored with an explicit
  // axis bound rendered at auto-computed bounds (user intent lost on every
  // preview, even though the serialised `.xlsx` carried the value).
  //
  // Handle each side independently: a single-sided bound (`min` without
  // `max`, or vice versa) still needs the other side computed from data.
  const authoredMin = axis?.valScaling?.min;
  const authoredMax = axis?.valScaling?.max;
  const hasAuthoredMin = typeof authoredMin === "number" && Number.isFinite(authoredMin);
  const hasAuthoredMax = typeof authoredMax === "number" && Number.isFinite(authoredMax);

  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    // Completely empty / non-finite dataset — fall back to a safe
    // [0, 1] range so downstream `valueToY` doesn't divide by zero.
    // Still honour explicit bounds so the plot still scales correctly
    // when the caller hands us a bound dataset with no finite points.
    const min = hasAuthoredMin ? (authoredMin as number) : 0;
    const max = hasAuthoredMax ? (authoredMax as number) : 1;
    return max > min ? { min, max } : { min, max: min + 1 };
  }
  // Fold over `reduce` instead of `Math.min(...arr)` / `Math.max(...arr)`
  // — the spread form blows the JS call stack past ~100k entries, and
  // waterfall / histogram / pareto series are exactly the workloads
  // that hit this limit.
  //
  // Compute the true data range first. The previous implementation
  // anchored `rawMax = 1` and `rawMin = 0`, which was correct for
  // bin-count axes but wrong for wholly-negative datasets (e.g.
  // `[-5, -3, -1]` produced `[-5, 1]`, wasting the upper half of
  // the plot area on whitespace). Widen zero-anchoring only when the
  // data actually straddles zero on that side; keep the `max >= 1`
  // pad ONLY when the data's natural max is positive — for negative
  // datasets the axis now ends at the max observed value.
  let dataMin = finite[0];
  let dataMax = finite[0];
  for (let i = 1; i < finite.length; i++) {
    const v = finite[i];
    if (v < dataMin) {
      dataMin = v;
    }
    if (v > dataMax) {
      dataMax = v;
    }
  }
  // Zero-anchor symmetry per ECMA-376 bar-like chart conventions:
  //   - mixed data (crosses zero)         → min = dataMin, max = max(1, dataMax)
  //   - wholly non-negative (dataMin ≥ 0) → min = 0, max = max(dataMax, dataMin + 1)
  //                                         (the +1 widens degenerate
  //                                          "all values equal" sets
  //                                          so ticks land on legible
  //                                          round numbers)
  //   - wholly negative (dataMax < 0)     → min = dataMin, max = 0 so
  //                                         the negative values sweep
  //                                         up to the axis
  //
  // The previous implementation forced `rawMax = Math.max(1, dataMax)`
  // whenever `dataMin <= 0`, which was correct for mixed data but
  // buggy for wholly-negative datasets (`[-5, -3, -1]` → `{min: -5,
  // max: 1}`, wasting the upper half of the plot area on whitespace
  // above zero). Zero-anchor to the top only when the data reaches or
  // exceeds 0; end the axis at the observed max otherwise.
  let rawMin: number;
  let rawMax: number;
  if (dataMin >= 0) {
    // All non-negative: anchor to 0, pad top for degenerate ranges.
    rawMin = 0;
    rawMax = Math.max(dataMax, dataMin + 1);
  } else if (dataMax < 0) {
    // All negative: anchor top to 0 so the bars sweep upward to the
    // zero line, showing the magnitude.
    rawMin = dataMin;
    rawMax = 0;
  } else {
    // Mixed (straddles zero): preserve the data range with a floor of
    // 1 on the positive side so small-magnitude bin counts still have
    // legible ticks.
    rawMin = dataMin;
    rawMax = Math.max(1, dataMax);
  }
  // Override with author-supplied bounds. Do this AFTER the data-derived
  // calculation so a single-sided authored bound still lets the other side
  // follow the data.
  const finalMin = hasAuthoredMin ? (authoredMin as number) : rawMin;
  const finalMax = hasAuthoredMax ? (authoredMax as number) : rawMax;
  if (finalMax <= finalMin) {
    // Degenerate or inverted bounds — widen so `valueToY` has a non-zero
    // span. When both bounds were authored we preserve the authored min
    // and invent a top; when one side is data-derived we nudge it to
    // exceed the authored side instead.
    if (hasAuthoredMin && hasAuthoredMax) {
      return { min: finalMin, max: finalMin + 1 };
    }
    if (hasAuthoredMin) {
      return { min: finalMin, max: finalMin + 1 };
    }
    if (hasAuthoredMax) {
      return { min: finalMax - 1, max: finalMax };
    }
    return { min: finalMin, max: finalMin + 1 };
  }
  return { min: finalMin, max: finalMax };
}

/**
 * Locate the "value" axis on a ChartEx plot area — the one whose
 * `valScaling` bounds (`min` / `max`) define the numeric range of the
 * displayed data. Chart2014 `CT_PlotArea` allows zero or more axes; for
 * the layouts that live in this renderer (histogram, pareto, waterfall,
 * boxWhisker) exactly one axis should carry `type === "val"`.
 *
 * Returns `undefined` when no such axis is authored, in which case the
 * caller should fall back to fully data-derived bounds.
 */
function findValueAxis(model: ChartExModel): ChartExAxis | undefined {
  const axes = model.chartSpace.chart.plotArea.axis;
  if (!axes || axes.length === 0) {
    return undefined;
  }
  return axes.find(a => a.type === "val");
}

function chartTitleText(title: ChartTitle | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  // Structured rich-text takes precedence — it's the authored form
  // when the builder created the title from a string literal.
  const richText = title.text?.paragraphs
    .map(p => (p.runs ?? []).map(r => r.text).join(""))
    .join("\n");
  if (richText) {
    return richText;
  }
  // Formula-linked titles resolve via the strRef cache — cache-populator
  // fills `strRef.cache.points[0].value` from the referenced cell at
  // workbook save time (and the parser carries `<cx:v>` through on
  // round-trip). Only expose a non-empty cached value so callers can
  // tell "unresolved" from "intentionally empty".
  const cached = title.strRef?.cache?.points?.[0]?.value;
  if (typeof cached === "string" && cached.length > 0) {
    return cached;
  }
  return undefined;
}

/**
 * Extract a hex-encoded fill colour from a shape's {@link ShapeProperties}
 * for rendering in the preview / vector PDF paths. Thin wrapper around
 * {@link previewShapeFillColor} kept for readability inside this file
 * (all the ChartEx renderers take `spPr` directly). Routes through
 * `getSpPrFill` so chart parts that were captured as raw XML by the
 * xform layer (the common case for loaded `.xlsx` files) still resolve
 * their fill correctly — before this fix the helper read
 * `spPr?.fill` directly, which is `undefined` for the `_rawXml` path
 * and dropped the authored colour back to the caller's fallback.
 */
function shapeFillColor(spPr: ShapeProperties | undefined, fallback: string): string {
  return previewShapeFillColor(spPr ? getSpPrFill(spPr) : undefined, fallback);
}
