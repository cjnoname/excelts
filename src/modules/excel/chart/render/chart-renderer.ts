import type {
  AxisDataSource,
  ChartAxis,
  ChartColor,
  ChartLegend,
  ChartMarker,
  ChartModel,
  ChartTextProperties,
  ChartTitle,
  ChartTypeGroup,
  DataLabelPosition,
  DataLabels,
  DataPoint,
  DataTable,
  EffectList,
  ErrorBars,
  LegendPosition,
  NumberLiteral,
  NumberReference,
  SeriesBase,
  ShapeProperties,
  StringReference,
  Trendline
} from "@excel/chart/model/types";
import type { RasterFont } from "@excel/chart/render/glyph-rasterizer";
import { loadSystemFont, rasterizeGlyph } from "@excel/chart/render/glyph-rasterizer";
import { STROKE_FONT } from "@excel/chart/render/stroke-font";
import type { PdfColor } from "@excel/chart/shared/chart-utils";
import {
  AXIS_COLOR,
  COLORS,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  GRID_COLOR,
  clamp01,
  escapeXml,
  escapeXmlAttr,
  fmt,
  hexToPdfColor,
  hexToPdfColorWithAlpha,
  interpolateColor,
  normalizeHex6,
  previewShapeFillColor,
  previewShapeLineColor,
  previewShapeLineWidthPx,
  resolveChartColor,
  valueToX,
  valueToY,
  withAlpha
} from "@excel/chart/shared/chart-utils";
import {
  parseSpPr,
  parseTxPr,
  getSpPrFill,
  getSpPrLine,
  getTxPrFontSize
} from "@excel/chart/shared/shape-properties";
import { measureTextWidthPx } from "@excel/utils/text-metrics";

export type { PdfColor };

// ---------------------------------------------------------------------------
// Plot layout constants — extracted from getPlotRect / legendRect so the
// spatial reasoning behind the scene builder is self-documenting.
// ---------------------------------------------------------------------------

/** Base left margin (space for Y-axis tick labels). */
const PLOT_MARGIN_LEFT = 58;
/** Base right margin (chart-edge padding). */
const PLOT_MARGIN_RIGHT = 24;
/** Extra right margin when a secondary value axis is present. */
const PLOT_SECONDARY_AXIS_WIDTH = 42;
/** Extra margin for an axis title label. */
const PLOT_AXIS_TITLE_PADDING = 18;
/** Top margin when no chart title is shown. */
const PLOT_MARGIN_TOP_NO_TITLE = 24;
/** Top margin when a chart title is shown. */
const PLOT_MARGIN_TOP_WITH_TITLE = 52;
/** Extra top space for a top-positioned axis. */
const PLOT_TOP_AXIS_HEIGHT = 22;
/** Extra top space for a top-axis title. */
const PLOT_TOP_AXIS_TITLE_HEIGHT = 16;
/** Extra top space when legend is placed at top. */
const PLOT_TOP_LEGEND_PADDING = 30;
/** Base bottom margin. */
const PLOT_MARGIN_BOTTOM = 24;
/** Default bottom-axis tick-label height (when no data table). */
const PLOT_BOTTOM_AXIS_LABEL_HEIGHT = 22;
/** Extra bottom space when legend is at bottom. */
const PLOT_BOTTOM_LEGEND_PADDING = 28;
/** Gap between legend rectangle edge and adjacent content. */
const LEGEND_GAP_LEFT = 12;
/** Gap between legend rectangle edge and adjacent content (right/topRight). */
const LEGEND_GAP_RIGHT = 16;
/** Minimum rendered plot dimension to avoid degenerate rects. */
const PLOT_MIN_DIMENSION = 10;

// Legend layout constants
/** Horizontal padding between legend entries. */
const LEGEND_ENTRY_PADDING = 32;
/** Legend colour swatch width. */
const LEGEND_SWATCH_WIDTH = 16;
/** Legend font size in pixels. */
const LEGEND_FONT_SIZE = 11;
/** Legend row height in pixels. */
const LEGEND_ROW_HEIGHT = 18;
/** Minimum legend width / height floor. */
const LEGEND_MIN_EXTENT = 96;
/** Outer margin from chart edges to legend edges. */
const LEGEND_OUTER_MARGIN = 20;
/** Total horizontal inset for horizontal legends (both sides combined). */
const LEGEND_HORIZ_INSET = 48;
/** Total vertical inset for vertical legends (top + bottom combined). */
const LEGEND_VERT_INSET = 48;
/** Top position for legend below title. */
const LEGEND_TOP_BELOW_TITLE = 48;
/** Top position for legend without title. */
const LEGEND_TOP_NO_TITLE = 20;
/** Vertical legend top offset when title present (tr position). */
const LEGEND_TR_WITH_TITLE = 44;

// ---------------------------------------------------------------------------
// Glyph rasterization cache — avoids re-rasterizing the same glyph outline
// at the same font size across repeated chart text rendering calls. Keyed by
// the GlyphOutline reference (stable per font + codePoint) and fontSize.
// ---------------------------------------------------------------------------
type RasterizedGlyph = {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pixels: Uint8Array;
};
const glyphCache = new WeakMap<object, Map<number, RasterizedGlyph>>();

function cachedRasterizeGlyph(
  outline: object & { contours: unknown[]; advanceWidth: number },
  fontSize: number,
  unitsPerEm: number
): RasterizedGlyph {
  let sizeMap = glyphCache.get(outline);
  if (!sizeMap) {
    sizeMap = new Map();
    glyphCache.set(outline, sizeMap);
  }
  let cached = sizeMap.get(fontSize);
  if (!cached) {
    cached = rasterizeGlyph(outline as Parameters<typeof rasterizeGlyph>[0], fontSize, unitsPerEm);
    sizeMap.set(fontSize, cached);
  }
  return cached;
}

/**
 * Options for the built-in deterministic chart preview renderer.
 *
 * The renderer is intentionally lightweight and self-contained; it produces a
 * stable SVG/PNG/PDF preview of chart data and core styling, not an
 * Excel-identical layout or rasterization.
 *
 * Notable scope boundaries:
 *
 * - **Text metrics** come from `@excel/utils/text-metrics` (Calibri/Arial/
 *   Times per-character widths + ~230 category fallbacks); legend and title
 *   layouts adapt to real label widths.
 * - **Data labels** honour every `DataLabelPosition` (see `positionDataLabel`).
 *   Pie/doughnut `outEnd`/`bestFit` layouts emit leader lines with a simple
 *   per-hemisphere greedy vertical nudge (`layoutPieLabels`). Bar/line labels
 *   drop or stack when `resolveLabelCollisions` detects bbox overlap.
 * - **PDF bridge** is feature-matched with the SVG path: labels (with
 *   anchor + color + fontFamily/bold/italic from `txPr`), markers
 *   (square/diamond/triangle/x/plus/circle), error bars, trendlines
 *   (with dash), leader lines, rotated axis titles, and real alpha on
 *   area/bubble/radar/bar3D fills flowing through `PdfColor.a` →
 *   `/ExtGState`. Surfaces that ignore the new optional fields receive
 *   the legacy call shape with pre-anchored coordinates and opaque
 *   colours, so pre-alpha consumers keep working unchanged.
 * - **3D charts** — `bar3D` renders as a true extruded box (top + front
 *   + right faces) whose axonometric projection is driven by
 *   `view3D.rotX` / `view3D.rotY` / `view3D.rAngAx`. See
 *   {@link resolveBar3DProjection}. The other 3D variants
 *   (`line3D`/`pie3D`/`area3D`/`surface3D`) render as their 2D
 *   equivalents — OOXML `view3D` / `Scene3D` / `ShapeProperties3D`
 *   metadata is preserved in the model but not consumed for those
 *   types; the renderer returns a deterministic preview rather than a
 *   full 3D scene.
 */
export interface ChartRenderOptions {
  width?: number;
  height?: number;
  title?: string;
  /** Background fill for SVG/PNG previews. Set to "transparent" for transparent PNG output. */
  backgroundColor?: string;
  /** Output scale multiplier for PNG previews. Useful for high-DPI exports. */
  scale?: number;
  /** PNG output DPI metadata. Stored as a pHYs chunk when provided. */
  dpi?: number;
  /**
   * Optional geographic data source for ChartEx `regionMap` previews.
   * When present and the matched features cover all labels, the
   * renderer draws country (or other region) outlines from the user-
   * supplied TopoJSON instead of falling back to the built-in
   * centroid-dot preview. Purely opt-in so the default library has
   * zero bundled geographic assets — supply e.g. `world-atlas`
   * `countries-110m.json` via `topology`.
   *
   * See {@link RegionMapDataOptions} and
   * `src/modules/excel/chart/topojson.ts`.
   */
  regionMap?: RegionMapDataOptions;
}

/**
 * Individual match rule for {@link RegionMapDataOptions.match}. A rule
 * is either the literal string `"id"` (compare against `feature.id`)
 * or `` `property:${propertyKey}` `` (compare against
 * `feature.properties[propertyKey]`). Multiple rules are combined via
 * an ordered fall-back array on the options object itself — see
 * {@link RegionMapDataOptions.match}.
 */
export type RegionMapMatchRule = "id" | `property:${string}`;

/**
 * User-supplied geographic data for `regionMap` rendering. The caller
 * is responsible for loading / caching the TopoJSON file — the library
 * is strictly zero-dependency and ships no map data.
 */
export interface RegionMapDataOptions {
  /**
   * Parsed TopoJSON topology. Compatible with the output of
   * `world-atlas` bundles or any `topojson-server` emitter.
   */
  topology: unknown;
  /**
   * Name of the geometry collection to draw — typically `"countries"`
   * for `world-atlas`. Throws at render time if missing from the
   * topology.
   */
  objectName: string;
  /**
   * How to match each chart category label to a TopoJSON feature.
   *
   * - `"id"` — compare against `feature.id`.
   * - `"property:<key>"` — compare against `feature.properties[key]`.
   *   Common for world-atlas: `"property:name"`.
   *
   * Accepts either a single rule (back-compat) or an ordered fall-back
   * list (`matchers`-style). When a list is supplied the renderer tries
   * each rule in order per feature and keeps the first one that finds a
   * data value for this feature; this is the pattern Natural-Earth-
   * derived topologies need when the categories are localised (e.g.
   * try `property:name_zh` first, then `property:name_en`, then fall
   * back to `id`). Comparison stays case-insensitive and
   * whitespace-trimmed for every rule. Default: `"id"`.
   */
  match?: RegionMapMatchRule | RegionMapMatchRule[];
  /**
   * Projection to use. Overrides `series.layoutPr.projection`. Supports
   * the same set the built-in renderer implements (`mercator`, `miller`,
   * `albers`, `robinson`).
   */
  projection?: "mercator" | "miller" | "albers" | "robinson";
  /**
   * Optional stroke colour for region borders. Default `"#FFFFFF"`.
   */
  strokeColor?: string;
}

export interface PdfChartRenderOptions extends ChartRenderOptions {
  x: number;
  y: number;
  /** Optional deterministic sink for regression tests; production drawing APIs can ignore it. */
  trace?: string[];
}

export interface ChartPdfDrawingSurface {
  drawRect(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    fill?: PdfColor;
    stroke?: PdfColor;
    /** Stroke width when `stroke` is set. Surfaces that ignore it fall back to 1 px. */
    lineWidth?: number;
  }): this;
  drawLine(options: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color?: PdfColor;
    /** Stroke width. Surfaces that ignore it fall back to 1 px. */
    lineWidth?: number;
    /**
     * PDF dash pattern (even entries are "on" lengths, odd entries are "off"
     * lengths, in points). Omit for a solid stroke. Surfaces without dash
     * support may ignore this silently.
     */
    dashPattern?: number[];
  }): this;
  /**
   * Draw a single line of text. `anchor` and `rotation` are honoured by
   * surfaces that support them; those that do not are expected to
   * treat the request as `start` / `0°` (i.e. legacy `drawText` behaviour).
   * Chart callers should not assume rotation is available and should
   * still pre-compute anchored x coordinates when a visual fallback is
   * required (see {@link drawPdfText}).
   */
  drawText(
    text: string,
    options: {
      x: number;
      y: number;
      fontSize?: number;
      color?: PdfColor;
      /**
       * Degrees, clockwise. Optional; only the PDF bridge built on
       * `@pdf/builder` honours it today.
       */
      rotation?: number;
      /**
       * Horizontal alignment around `x`. Optional; chart code supplies an
       * explicit pre-anchored `x` as a fallback so surfaces that ignore
       * this still render at the correct position.
       */
      anchor?: "start" | "middle" | "end";
      bold?: boolean;
      italic?: boolean;
      fontFamily?: string;
    }
  ): this;
  drawCircle?(options: {
    cx: number;
    cy: number;
    r: number;
    fill?: PdfColor;
    stroke?: PdfColor;
    lineWidth?: number;
  }): this;
  drawPath?(
    ops: ChartPdfPathOp[],
    options?: {
      fill?: PdfColor;
      stroke?: PdfColor;
      closePath?: boolean;
      lineWidth?: number;
      dashPattern?: number[];
    }
  ): this;
}

export type ChartPdfPathOp =
  | { op: "move"; x: number; y: number }
  | { op: "line"; x: number; y: number }
  | { op: "curve"; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { op: "close" };

export interface ChartScene {
  width: number;
  height: number;
  title?: ChartSceneText;
  plot: ChartSceneRect;
  axes: { x?: ChartSceneLine; y?: ChartSceneLine; x2?: ChartSceneLine; y2?: ChartSceneLine };
  gridlines: ChartSceneLine[];
  xLabels: ChartSceneText[];
  yLabels: ChartSceneText[];
  secondaryXLabels: ChartSceneText[];
  secondaryYLabels: ChartSceneText[];
  axisTitles: ChartSceneText[];
  series: ChartSceneSeries[];
  legend: ChartSceneLegend;
  /**
   * Data-table overlay drawn below the plot area when
   * `model.chart.plotArea.dataTable` is set. The preview writes a
   * compact grid using the same deterministic text-metrics pipeline as
   * the rest of the scene. Full OOXML `c:dTable` styling is honoured at
   * the XML-round-trip level; this preview covers the four display
   * switches (`showHorzBorder`, `showVertBorder`, `showOutline`,
   * `showKeys`) and the typography derived from `txPr`. When the data
   * table is present, the primary x-axis labels are suppressed — Excel
   * does the same so category names only appear once.
   */
  dataTable?: ChartSceneDataTable;
  /**
   * SVG filter definitions referenced by individual series via
   * `effectFilterId`. One entry per unique `a:effectLst` observed on
   * the normalised series. Rendered into `<defs>` by
   * {@link renderChartSvg}; the PDF surface ignores them because SVG
   * filters don't map directly onto PDF graphics state.
   */
  effectFilters: ChartSceneEffectFilter[];
}

/**
 * Layout-resolved representation of a `c:dTable` element for the
 * preview pipeline. Geometry is already in pixel space so SVG/PDF/PNG
 * bridges can consume it uniformly.
 */
export interface ChartSceneDataTable {
  /** Outer rectangle containing the entire table. */
  rect: ChartSceneRect;
  /**
   * Column boundaries (x coordinates) including the left and right
   * edges. `columns[0]` is the left edge of the series-name column,
   * `columns[1]` starts the first category cell, and so on.
   */
  columns: number[];
  /**
   * Row boundaries (y coordinates) including the top and bottom edges.
   * `rows[0]` is the header row (category names) if it's non-empty,
   * `rows[1..]` are the per-series rows.
   */
  rows: number[];
  /** Text nodes for every cell — series name plus each value. */
  cells: ChartSceneText[];
  /**
   * Legend-key swatches drawn to the left of each series name when
   * `showKeys` is enabled. Colors match the series `color`.
   */
  legendSwatches: Array<ChartSceneRect & { color: string }>;
  /** Border strokes derived from `showHorzBorder` / `showVertBorder` / `showOutline`. */
  borders: ChartSceneLine[];
}

export interface ChartSceneEffectFilter {
  /** Stable id the series references in `filter="url(#<id>)"`. */
  id: string;
  /** Full `<filter>…</filter>` XML produced by {@link buildEffectFilter}. */
  xml: string;
}

export interface ChartSceneLegend {
  items: Array<{ label: string; color: string }>;
  rect: ChartSceneRect;
  visible: boolean;
  position?: LegendPosition;
  orientation: "horizontal" | "vertical";
  /**
   * Font-related overrides derived from `model.chart.legend.txPr`
   * (see {@link textStyleFromTxPr}). When populated these flow into
   * both the SVG legend emit and the PDF legend renderer so legend
   * labels match the typography the author requested in the chart
   * XML. `undefined` fields keep the renderer defaults (10 pt Arial).
   */
  textStyle?: {
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    color?: string;
  };
}

export type ChartSceneSeries =
  | ChartSceneBarSeries
  | ChartSceneAreaSeries
  | ChartSceneLineSeries
  | ChartSceneBubbleSeries
  | ChartScenePieSeries
  | ChartSceneRadarSeries
  | ChartSceneStockSeries
  | ChartSceneSurfaceSeries;

export interface ChartSceneAdornment {
  labels?: ChartSceneText[];
  markers?: ChartSceneMarker[];
  trendlines?: ChartSceneTrendline[];
  errorBars?: ChartSceneErrorBar[];
  /**
   * Leader lines connecting data labels to their data points. Currently
   * emitted only by pie/doughnut series when the effective
   * `DataLabelPosition` places labels outside the slice (`outEnd`,
   * `bestFit`). The renderer treats them as decorative strokes and does
   * not attempt collision avoidance beyond the greedy fan-out already
   * applied by {@link buildDataLabels}.
   */
  leaderLines?: ChartSceneLine[];
  /**
   * SVG `<filter>` id assigned by {@link buildChartScene} when this
   * series carries a DrawingML `a:effectLst` (shadow, glow, reflection,
   * soft-edge, blur, inner-shadow). `renderChartSvg` emits the matching
   * `<filter>` in the SVG `<defs>` block and the series' primary shape
   * references it via `filter="url(#<id>)"`.
   *
   * Only present on series whose `spPr.effectList` was non-empty; other
   * series render without a filter attribute so the shared `<defs>` does
   * not bloat the output.
   */
  effectFilterId?: string;
}

export interface ChartSceneBarSeries extends ChartSceneAdornment {
  type: "bar";
  color: string;
  bars: ChartSceneRect[];
  label?: string;
  horizontal?: boolean;
  /**
   * Decorative depth hint (pixels) used only by the SVG/PNG preview to
   * distinguish `bar3D` from `bar`. When `projection3D` is also present
   * the renderer uses this depth along with the projection deltas to
   * emit a proper extruded box (top + front + right side faces, with
   * shading). For plain `bar` this stays `0` and only the front rect
   * is drawn.
   */
  depth?: number;
  /**
   * Axonometric projection deltas derived from OOXML `view3D.rotX` /
   * `view3D.rotY`. Populated for `bar3D` series so the renderer can
   * extrude each bar into a true 3D box: the back face sits at
   * `(bar.x + dx, bar.y - dy)` and back-right edge at
   * `(bar.x + bar.width + dx, …)`. `undefined` for plain `bar` series
   * where no 3D transform applies.
   */
  projection3D?: { dx: number; dy: number };
}

export interface ChartSceneAreaSeries extends ChartSceneAdornment {
  type: "area";
  color: string;
  points: ChartScenePoint[];
  lowerPoints?: ChartScenePoint[];
  baselineY: number;
  label?: string;
  closed?: boolean;
}

export interface ChartSceneLineSeries extends ChartSceneAdornment {
  type: "line" | "scatter";
  color: string;
  points: ChartScenePoint[];
  label?: string;
  smooth?: boolean;
  showLine?: boolean;
}

export interface ChartSceneBubbleSeries extends ChartSceneAdornment {
  type: "bubble";
  color: string;
  bubbles: ChartSceneBubble[];
  label?: string;
}

export interface ChartScenePieSeries extends ChartSceneAdornment {
  type: "pie" | "doughnut" | "ofPie";
  slices: ChartScenePieSlice[];
  secondarySlices?: ChartScenePieSlice[];
  connectors?: ChartSceneLine[];
  label?: string;
}

export interface ChartSceneRadarSeries extends ChartSceneAdornment {
  type: "radar";
  color: string;
  points: ChartScenePoint[];
  center: ChartScenePoint;
  radius: number;
  filled?: boolean;
  label?: string;
}

export interface ChartSceneStockSeries extends ChartSceneAdornment {
  type: "stock";
  color: string;
  candles: ChartSceneStockCandle[];
  label?: string;
}

export interface ChartSceneSurfaceSeries extends ChartSceneAdornment {
  type: "surface";
  cells: ChartSceneSurfaceCell[];
  wireframe?: boolean;
  label?: string;
}

export interface ChartSceneBubble extends ChartScenePoint {
  radius: number;
}

export interface ChartSceneMarker extends ChartScenePoint {
  color: string;
  size: number;
  symbol?: NonNullable<ChartMarker["symbol"]>;
}

export interface ChartSceneTrendline {
  color: string;
  width?: number;
  dash?: string;
  points: ChartScenePoint[];
  label?: ChartSceneText;
}

export interface ChartSceneErrorBar {
  line: ChartSceneLine;
  cap1?: ChartSceneLine;
  cap2?: ChartSceneLine;
}

export interface ChartSceneStockCandle {
  x: number;
  highY: number;
  lowY: number;
  openY?: number;
  closeY?: number;
  width: number;
  up: boolean;
}

export interface ChartSceneSurfaceCell extends ChartSceneRect {
  color: string;
}

interface NormalizedSeries {
  group: ChartTypeGroup;
  groupIndex: number;
  series: SeriesBase;
  seriesIndex: number;
  globalIndex: number;
  label: string;
  color: string;
  /** Values already passed through the axis log transform (display space). */
  values: number[];
  categories?: string[];
  /** X values already passed through the x axis log transform (display space). */
  xValues?: number[];
  /**
   * Pre-transform y values (raw data). Separate from {@link values} so
   * trendline regression can fit the curve on the author's original
   * numbers — fitting in display space silently turns every "linear"
   * trendline on a log-scale chart into an exponential fit (the
   * implicit `log(y) = a + bx` becomes `y = c * base^(bx)`), which
   * mismatches Excel's behaviour and user expectations.
   */
  rawValues: number[];
  /** Pre-transform x values (raw data). */
  rawXValues?: number[];
  /**
   * Y-axis log base, if any. Null when the value axis is linear.
   * Trendline sample points must re-apply this transform before being
   * mapped to pixels via {@link valueToY}, which receives the
   * already-transformed `min`/`max`.
   */
  yLogBase?: number;
  /** X-axis log base for scatter/bubble charts on a log x axis. */
  xLogBase?: number;
  bubbleSizes?: number[];
  dataLabels?: DataLabels;
  trendlines?: Trendline[];
  errorBars?: ErrorBars[];
  marker?: ChartMarker;
}

interface ValueRange {
  min: number;
  max: number;
}

interface ChartAxisContext {
  axesById: Map<number, ChartAxis>;
  primaryXAxis?: ChartAxis;
  primaryYAxis?: ChartAxis;
  secondaryXAxis?: ChartAxis;
  secondaryYAxis?: ChartAxis;
  yRangesByAxisId: Map<number, ValueRange>;
  xRangesByAxisId: Map<number, ValueRange>;
  defaultYRange: ValueRange;
  defaultXRange: ValueRange;
}

export interface ChartScenePieSlice {
  color: string;
  cx: number;
  cy: number;
  radius: number;
  innerRadius: number;
  startAngle: number;
  endAngle: number;
}

export interface ChartSceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width?: number;
}

export interface ChartSceneText {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  anchor?: "start" | "middle" | "end";
  rotate?: number;
  /**
   * Font family typeface, populated from OOXML `a:latin/@typeface` when
   * the originating `txPr` carries a font. `undefined` keeps the
   * renderer defaults: `"Arial"` for SVG, `"Helvetica"` for PDF. The
   * SVG and PDF bridges both honour this — the PDF `FontManager`
   * handles unknown families by silently mapping to Helvetica.
   */
  fontFamily?: string;
  /** Bold from `a:rPr/@b` / `a:defRPr/@b`. */
  bold?: boolean;
  /** Italic from `a:rPr/@i` / `a:defRPr/@i`. */
  italic?: boolean;
}

export interface ChartSceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartScenePoint {
  x: number;
  y: number;
}

/**
 * Fold-based `Math.max` for per-series `.values.length` — avoids the
 * `Math.max(1, ...arr.map(...))` spread which blows the JS call stack
 * for timeseries past ~100k points.
 */
function maxSeriesLength(groupSeries: readonly { values: readonly unknown[] }[]): number {
  let max = 1;
  for (const s of groupSeries) {
    if (s.values.length > max) {
      max = s.values.length;
    }
  }
  return max;
}

export function buildChartScene(model: ChartModel, options: ChartRenderOptions = {}): ChartScene {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const titleText = options.title ?? extractTitle(model);
  // `title.overlay === true` instructs Excel to paint the title on top
  // of the plot area rather than reserving space above it. Thread this
  // into `getPlotRect` so the plot uses the full chart height when an
  // overlay title is set — previously the title always pushed the plot
  // down by ~52 px regardless of `overlay`, wasting the top band of an
  // Excel-authored overlay title chart.
  const titleOverlay = model.chart.title?.overlay === true;
  const hasReservedTitle = !!titleText && !titleOverlay;
  const groups = model.chart.plotArea.chartTypes;
  const normalized = normalizeSeries(groups, model);
  const seriesValues = normalized.map(s => s.values);
  const categories =
    normalized.find(s => s.categories && s.categories.length > 0)?.categories ??
    seriesValues[0]?.map((_, i) => String(i + 1)) ??
    [];
  const legend = buildSceneLegend(
    model.chart.legend,
    normalized,
    width,
    height,
    hasReservedTitle,
    categories
  );
  // Data tables sit below the plot area. Pre-compute their vertical
  // footprint so `getPlotRect` can reserve space before series-level
  // geometry is built. Sizing uses the same text-metrics pipeline as
  // the rest of the scene for consistent wrap behaviour.
  const dataTableSpec = model.chart.plotArea.dataTable;
  const dataTableHeight = dataTableSpec
    ? computeDataTableHeight(dataTableSpec, normalized, categories)
    : 0;
  const plot = getPlotRect(
    width,
    height,
    hasReservedTitle,
    legend,
    model,
    dataTableHeight,
    categories.length
  );
  const axisContext = buildAxisContext(model, normalized);
  const sceneSeries = buildSceneSeries(
    groups,
    normalized,
    plot,
    axisContext,
    categories,
    model.chart.view3D
  );
  // Harvest any `a:effectLst` DrawingML from each series' `spPr` and
  // translate it into SVG `<filter>` markup. Two series with identical
  // effect lists share a single filter definition — the cache key is
  // a stable JSON stringify of the effect tree. The writer (renderChartSvg)
  // embeds the filters in `<defs>` and each series references its
  // filter via the `effectFilterId` we thread onto the scene.
  const effectFilters = assignEffectFilters(normalized, sceneSeries);
  const dataTable = dataTableSpec
    ? buildSceneDataTable(dataTableSpec, normalized, categories, plot, dataTableHeight)
    : undefined;
  const primaryYRange = axisContext.primaryYAxis
    ? (axisContext.yRangesByAxisId.get(axisContext.primaryYAxis.axId) ?? axisContext.defaultYRange)
    : axisContext.defaultYRange;
  const secondaryYRange = axisContext.secondaryYAxis
    ? (axisContext.yRangesByAxisId.get(axisContext.secondaryYAxis.axId) ??
      axisContext.defaultYRange)
    : undefined;
  const primaryXRange = axisContext.primaryXAxis
    ? (axisContext.xRangesByAxisId.get(axisContext.primaryXAxis.axId) ?? axisContext.defaultXRange)
    : axisContext.defaultXRange;
  const secondaryXRange = axisContext.secondaryXAxis
    ? (axisContext.xRangesByAxisId.get(axisContext.secondaryXAxis.axId) ??
      axisContext.defaultXRange)
    : undefined;
  const secondaryXCategories = categoriesForAxis(
    normalized,
    axisContext.secondaryXAxis,
    categories
  );

  // Pie / doughnut / pie3D charts have no axes — suppress gridlines,
  // labels, and axis lines so the preview only renders slices + legend.
  const isPieOnly = groups.every(
    g => g.type === "pie" || g.type === "pie3D" || g.type === "doughnut"
  );

  return {
    width,
    height,
    title: titleText
      ? {
          x: width / 2,
          y: 26,
          text: titleText,
          fontSize: 18,
          // Default chart-title colour matches the pre-textStyle
          // renderer; authors who supplied an explicit txPr colour win.
          color:
            (model.chart.title
              ? colorFromChartTextProperties(model.chart.title.txPr)
              : undefined) ?? "#222222",
          anchor: "middle",
          ...textStyleFromTxPr(model.chart.title?.txPr)
        }
      : undefined,
    plot,
    gridlines: isPieOnly
      ? []
      : buildGridlines(
          plot,
          axisContext.primaryYAxis,
          primaryYRange,
          axisContext.primaryXAxis,
          primaryXRange,
          categories
        ),
    // When a data table is drawn, Excel suppresses the primary x-axis
    // category labels because categories already appear as the header
    // row of the table. We keep gridlines and the axis line itself so
    // the plot boundary stays intact.
    xLabels: isPieOnly
      ? []
      : dataTable
        ? []
        : buildXLabels(categories, plot, axisContext.primaryXAxis, primaryXRange),
    yLabels: isPieOnly
      ? []
      : buildYLabels(
          primaryYRange.min,
          primaryYRange.max,
          plot,
          axisContext.primaryYAxis,
          false,
          categories
        ),
    secondaryXLabels: isPieOnly
      ? []
      : axisContext.secondaryXAxis
        ? buildXLabels(
            secondaryXCategories,
            plot,
            axisContext.secondaryXAxis,
            secondaryXRange,
            true
          )
        : [],
    secondaryYLabels: isPieOnly
      ? []
      : axisContext.secondaryYAxis && secondaryYRange
        ? buildYLabels(
            secondaryYRange.min,
            secondaryYRange.max,
            plot,
            axisContext.secondaryYAxis,
            true,
            categories
          )
        : [],
    axisTitles: isPieOnly ? [] : buildAxisTitles(axisContext, plot),
    series: sceneSeries,
    legend,
    dataTable,
    effectFilters,
    axes: isPieOnly
      ? { x: undefined, y: undefined, x2: undefined, y2: undefined }
      : {
          x: applyLineStyle(
            {
              x1: plot.x,
              y1: plot.y + plot.height,
              x2: plot.x + plot.width,
              y2: plot.y + plot.height,
              color: AXIS_COLOR
            },
            axisContext.primaryXAxis
          ),
          y: applyLineStyle(
            {
              x1: plot.x,
              y1: plot.y,
              x2: plot.x,
              y2: plot.y + plot.height,
              color: AXIS_COLOR
            },
            axisContext.primaryYAxis
          ),
          x2: axisContext.secondaryXAxis
            ? applyLineStyle(
                {
                  x1: plot.x,
                  y1: plot.y,
                  x2: plot.x + plot.width,
                  y2: plot.y,
                  color: AXIS_COLOR
                },
                axisContext.secondaryXAxis
              )
            : undefined,
          y2: axisContext.secondaryYAxis
            ? applyLineStyle(
                {
                  x1: plot.x + plot.width,
                  y1: plot.y,
                  x2: plot.x + plot.width,
                  y2: plot.y + plot.height,
                  color: AXIS_COLOR
                },
                axisContext.secondaryYAxis
              )
            : undefined
        }
  };
}

export function renderChartSvg(model: ChartModel, options: ChartRenderOptions = {}): string {
  const scene = buildChartScene(model, options);
  const parts: string[] = [];
  const backgroundColor = options.backgroundColor ?? "#fff";
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`
  );
  parts.push("<!-- deterministic preview; not an Excel-identical layout -->");
  if (backgroundColor !== "transparent") {
    parts.push(`<rect width="100%" height="100%" fill="${escapeXmlAttr(backgroundColor)}"/>`);
  }
  // Emit filter definitions before any drawing so shapes can reference
  // them via `filter="url(#...)"`. Keeping `<defs>` at the top of the
  // SVG matches the convention used by Inkscape/Illustrator and plays
  // nicely with rasteriser pre-scan passes.
  if (scene.effectFilters.length > 0) {
    parts.push("<defs>");
    for (const f of scene.effectFilters) {
      parts.push(f.xml);
    }
    parts.push("</defs>");
  }
  if (scene.title) {
    parts.push(renderSvgText(scene.title));
  }
  for (const gridline of scene.gridlines) {
    parts.push(renderSvgLine(gridline));
  }
  if (scene.axes.x) {
    parts.push(renderSvgLine(scene.axes.x));
  }
  if (scene.axes.y) {
    parts.push(renderSvgLine(scene.axes.y));
  }
  if (scene.axes.x2) {
    parts.push(renderSvgLine(scene.axes.x2));
  }
  if (scene.axes.y2) {
    parts.push(renderSvgLine(scene.axes.y2));
  }
  for (const label of scene.xLabels) {
    parts.push(renderSvgText(label));
  }
  for (const label of scene.yLabels) {
    parts.push(renderSvgText(label));
  }
  for (const label of scene.secondaryXLabels) {
    parts.push(renderSvgText(label));
  }
  for (const label of scene.secondaryYLabels) {
    parts.push(renderSvgText(label));
  }
  for (const title of scene.axisTitles) {
    parts.push(renderSvgText(title));
  }
  // Two-pass series rendering so every series' adornments (data labels,
  // trendlines, error bars, markers) paint on top of *every* series'
  // filled shapes. A single-pass emission ran `renderSvgSeries` which
  // drew a series' rects/polygons and then immediately its adornments,
  // meaning the next series' filled area polygons / stacked bars
  // covered the previous series' labels — especially bad on
  // semi-transparent area/radar fills where labels were half-masked.
  for (const s of scene.series) {
    renderSvgSeries(parts, s);
  }
  for (const s of scene.series) {
    renderSvgAdornments(parts, s);
  }
  if (scene.dataTable) {
    renderSvgDataTable(parts, scene.dataTable);
  }
  renderSvgLegend(parts, scene.legend);
  parts.push("</svg>");
  return parts.join("");
}

export async function renderChartPng(
  model: ChartModel,
  options: ChartRenderOptions = {}
): Promise<Uint8Array> {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const scale = normalizePngScale(options.scale);
  const svg = renderChartSvg(model, { ...options, width, height });
  return renderSvgToPng(svg, { width, height, scale, dpi: options.dpi });
}

export async function renderSvgToPng(
  svg: string,
  options: Required<Pick<ChartRenderOptions, "width" | "height">> &
    Pick<ChartRenderOptions, "scale" | "dpi">
): Promise<Uint8Array> {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const scale = normalizePngScale(options.scale);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return renderSvgToBasicPng(svg, width, height, scale, options.dpi);
  }
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context is unavailable");
    }
    ctx.drawImage(image, 0, 0, outputWidth, outputHeight);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("Canvas PNG encoding failed"));
        }
      }, "image/png");
    });
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderSvgToBasicPng(
  svg: string,
  width: number,
  height: number,
  scale: number,
  dpi: number | undefined
): Uint8Array {
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = new BasicRasterCanvas(outputWidth, outputHeight, scale);
  const tagRe = /<(rect|line|circle|polyline|polygon|path)\b[^>]*>|<text\b[^>]*>[\s\S]*?<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(svg)) !== null) {
    const tag = match[0];
    const name = tag.startsWith("<text") ? "text" : match[1];
    const attrs = parseSvgAttrs(tag);
    if (name === "rect") {
      const x = numAttr(attrs, "x") * scale;
      const y = numAttr(attrs, "y") * scale;
      const rectWidth = numAttr(attrs, "width", 0, width) * scale;
      const rectHeight = numAttr(attrs, "height", 0, height) * scale;
      const strokeWidth = numAttr(attrs, "stroke-width", 1) * scale;
      if (attrs.fill !== undefined) {
        canvas.fillRect(x, y, rectWidth, rectHeight, attrs.fill);
      }
      if (attrs.stroke !== undefined && strokeWidth > 0) {
        canvas.strokeRect(x, y, rectWidth, rectHeight, attrs.stroke, strokeWidth);
      }
    } else if (name === "line") {
      canvas.drawLine(
        numAttr(attrs, "x1") * scale,
        numAttr(attrs, "y1") * scale,
        numAttr(attrs, "x2") * scale,
        numAttr(attrs, "y2") * scale,
        attrs.stroke,
        numAttr(attrs, "stroke-width", 1) * scale
      );
    } else if (name === "circle") {
      canvas.fillCircle(
        numAttr(attrs, "cx") * scale,
        numAttr(attrs, "cy") * scale,
        numAttr(attrs, "r") * scale,
        attrs.fill
      );
      canvas.strokeCircle(
        numAttr(attrs, "cx") * scale,
        numAttr(attrs, "cy") * scale,
        numAttr(attrs, "r") * scale,
        attrs.stroke,
        numAttr(attrs, "stroke-width", 1) * scale
      );
    } else if (name === "polyline") {
      canvas.drawPolyline(
        parseSvgPoints(attrs.points, scale),
        attrs.stroke,
        numAttr(attrs, "stroke-width", 1) * scale
      );
    } else if (name === "polygon") {
      const points = parseSvgPoints(attrs.points, scale);
      canvas.fillPolygon(points, attrs.fill);
      if (points.length > 0) {
        canvas.drawPolyline(
          [...points, points[0]],
          attrs.stroke,
          numAttr(attrs, "stroke-width", 1) * scale
        );
      }
    } else if (name === "path") {
      // Pie/doughnut slices emit `data-sector="cx,cy,outerR,innerR,startAngle,endAngle"`
      // for pixel-perfect circular rendering instead of polygon approximation.
      const sectorData = attrs["data-sector"];
      if (sectorData) {
        const parts = sectorData.split(",").map(Number);
        if (parts.length === 6 && parts.every(Number.isFinite)) {
          const [cx, cy, outerR, innerR, startAngle, endAngle] = parts;
          canvas.fillSector(
            cx * scale,
            cy * scale,
            outerR * scale,
            innerR * scale,
            startAngle,
            endAngle,
            attrs.fill
          );
        }
      } else {
        const points = parsePathPoints(attrs.d, scale);
        canvas.fillPolygon(points, attrs.fill);
        if (points.length > 0) {
          canvas.drawPolyline(
            [...points, points[0]],
            attrs.stroke,
            numAttr(attrs, "stroke-width", 1) * scale
          );
        }
      }
    } else if (name === "text") {
      const rotation = parseSvgRotateTransform(attrs.transform);
      canvas.drawText(
        numAttr(attrs, "x") * scale,
        numAttr(attrs, "y") * scale,
        decodeSvgText(tag.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? ""),
        numAttr(attrs, "font-size", 10) * scale,
        attrs.fill,
        attrs["text-anchor"],
        rotation
          ? {
              angle: rotation.angle,
              originX: rotation.originX * scale,
              originY: rotation.originY * scale
            }
          : undefined
      );
    }
  }
  return encodePng(outputWidth, outputHeight, canvas.data, dpi);
}

class BasicRasterCanvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly scale = 1
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  fillRect(x: number, y: number, width: number, height: number, color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || width <= 0 || height <= 0) {
      return;
    }
    const x0 = clampInt(Math.floor(x), 0, this.width);
    const y0 = clampInt(Math.floor(y), 0, this.height);
    const x1 = clampInt(Math.ceil(x + width), 0, this.width);
    const y1 = clampInt(Math.ceil(y + height), 0, this.height);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        this.setPixel(xx, yy, rgba);
      }
    }
  }

  strokeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: string | undefined,
    strokeWidth = 1
  ): void {
    this.drawLine(x, y, x + width, y, color, strokeWidth);
    this.drawLine(x + width, y, x + width, y + height, color, strokeWidth);
    this.drawLine(x + width, y + height, x, y + height, color, strokeWidth);
    this.drawLine(x, y + height, x, y, color, strokeWidth);
  }

  drawPolyline(points: ChartScenePoint[], color: string | undefined, width = 1): void {
    if (points.length < 2) {
      return;
    }
    for (let i = 1; i < points.length; i++) {
      this.drawLine(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, color, width);
    }
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string | undefined,
    width = 1
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }
    let x0 = Math.round(x1);
    let y0 = Math.round(y1);
    const xEnd = Math.round(x2);
    const yEnd = Math.round(y2);
    const dx = Math.abs(xEnd - x0);
    const sx = x0 < xEnd ? 1 : -1;
    const dy = -Math.abs(yEnd - y0);
    const sy = y0 < yEnd ? 1 : -1;
    let err = dx + dy;
    const radius = Math.max(0, Math.floor(width / 2));
    while (true) {
      for (let yy = y0 - radius; yy <= y0 + radius; yy++) {
        for (let xx = x0 - radius; xx <= x0 + radius; xx++) {
          this.setPixel(xx, yy, rgba);
        }
      }
      if (x0 === xEnd && y0 === yEnd) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || r <= 0) {
      return;
    }
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    const rr = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rr) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  strokeCircle(cx: number, cy: number, r: number, color: string | undefined, width = 1): void {
    const points: ChartScenePoint[] = [];
    const steps = Math.max(12, Math.ceil(r * 2));
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    this.drawPolyline(points, color, width);
  }

  /**
   * Fill a circular sector (pie slice) with pixel-level precision.
   * Uses distance + angle tests per pixel instead of polygon scanline,
   * producing smooth circular edges without polygon approximation artifacts.
   */
  fillSector(
    cx: number,
    cy: number,
    outerR: number,
    innerR: number,
    startAngle: number,
    endAngle: number,
    color: string | undefined
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba || outerR <= 0) {
      return;
    }
    const x0 = clampInt(Math.floor(cx - outerR), 0, this.width);
    const x1 = clampInt(Math.ceil(cx + outerR), 0, this.width);
    const y0 = clampInt(Math.floor(cy - outerR), 0, this.height);
    const y1 = clampInt(Math.ceil(cy + outerR), 0, this.height);
    const outerRR = outerR * outerR;
    const innerRR = innerR * innerR;
    // Normalise angles to [0, 2π)
    let sa = startAngle % (Math.PI * 2);
    if (sa < 0) {
      sa += Math.PI * 2;
    }
    let ea = endAngle % (Math.PI * 2);
    if (ea < 0) {
      ea += Math.PI * 2;
    }
    const crossesZero = ea < sa;
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > outerRR || dist2 < innerRR) {
          continue;
        }
        let angle = Math.atan2(dy, dx);
        if (angle < 0) {
          angle += Math.PI * 2;
        }
        const inAngle = crossesZero ? angle >= sa || angle <= ea : angle >= sa && angle <= ea;
        if (inAngle) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  fillPolygon(points: ChartScenePoint[], color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || points.length < 3) {
      return;
    }
    // Use `reduce` rather than `Math.min(...arr)` / `Math.max(...arr)` —
    // polygons used for chart fills are small, but the PNG rasteriser
    // also feeds this helper with large path-derived point sets and we
    // want the safe default everywhere.
    let minYRaw = points[0].y;
    let maxYRaw = points[0].y;
    for (const p of points) {
      if (p.y < minYRaw) {
        minYRaw = p.y;
      }
      if (p.y > maxYRaw) {
        maxYRaw = p.y;
      }
    }
    const minY = clampInt(Math.floor(minYRaw), 0, this.height - 1);
    const maxY = clampInt(Math.ceil(maxYRaw), 0, this.height - 1);
    for (let y = minY; y <= maxY; y++) {
      const intersections: number[] = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if (a.y > y !== b.y > y) {
          intersections.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
        }
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i < intersections.length; i += 2) {
        const x0 = clampInt(Math.floor(intersections[i]), 0, this.width - 1);
        const x1 = clampInt(Math.ceil(intersections[i + 1] ?? intersections[i]), 0, this.width - 1);
        for (let x = x0; x <= x1; x++) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  drawText(
    x: number,
    y: number,
    text: string,
    fontSize: number,
    color: string | undefined,
    anchor: string | undefined,
    rotation?: { angle: number; originX: number; originY: number }
  ): void {
    if (!text) {
      return;
    }
    // Use the same font-metrics engine as the SVG path so legend/title
    // anchoring rasterises at the right offsets.
    const measured = estimateTextWidth(text, fontSize);
    const textWidth = measured > 0 ? measured : Math.max(1, fontSize * 0.5) * text.length;
    const startX = anchor === "middle" ? x - textWidth / 2 : anchor === "end" ? x - textWidth : x;

    // Try system font rasterization first (high quality filled glyphs)
    const font = loadSystemFont();
    if (font) {
      this.drawTextWithFont(font, startX, y, text, fontSize, textWidth, color, rotation);
      return;
    }

    // Fallback: stroke font
    this.drawTextStroke(startX, y, text, fontSize, textWidth, color, rotation);
  }

  private drawTextWithFont(
    font: RasterFont,
    startX: number,
    y: number,
    text: string,
    fontSize: number,
    textWidth: number,
    color: string | undefined,
    rotation?: { angle: number; originX: number; originY: number }
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }

    const scale = fontSize / font.unitsPerEm;

    // Compute total advance from font metrics, then scale to match measured width.
    // Iterate by code point (not UTF-16 code unit) so surrogate pairs for
    // non-BMP characters resolve to a single glyph lookup.
    let totalAdvance = 0;
    for (const ch of text) {
      const outline = font.getOutline(ch.codePointAt(0)!);
      totalAdvance += outline ? outline.advanceWidth * scale : fontSize * 0.4;
    }
    const hScale = totalAdvance > 0 ? textWidth / totalAdvance : 1;

    const theta = rotation && rotation.angle !== 0 ? (rotation.angle * Math.PI) / 180 : 0;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ox = rotation ? rotation.originX : 0;
    const oy = rotation ? rotation.originY : 0;

    let curX = startX;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const outline = font.getOutline(code);
      if (!outline) {
        curX += fontSize * 0.4 * hScale;
        continue;
      }

      const glyph = cachedRasterizeGlyph(outline, fontSize, font.unitsPerEm);
      if (glyph.pixels.length === 0) {
        curX += outline.advanceWidth * scale * hScale;
        continue;
      }

      // Position: baseline is at y; glyph offsetY is relative to baseline
      const baseX = curX + glyph.offsetX;
      const baseY = y + glyph.offsetY;

      for (let row = 0; row < glyph.height; row++) {
        for (let col = 0; col < glyph.width; col++) {
          const coverage = glyph.pixels[row * glyph.width + col];
          if (coverage > 0) {
            let px = baseX + col;
            let py = baseY + row;
            if (theta !== 0) {
              const dx = px - ox;
              const dy = py - oy;
              px = ox + dx * cos - dy * sin;
              py = oy + dx * sin + dy * cos;
            }
            // Use coverage as alpha for anti-aliased rendering
            const aa: [number, number, number, number] = [rgba[0], rgba[1], rgba[2], coverage];
            this.setPixel(Math.round(px), Math.round(py), aa);
          }
        }
      }
      curX += outline.advanceWidth * scale * hScale;
    }
  }

  private drawTextStroke(
    startX: number,
    y: number,
    text: string,
    fontSize: number,
    textWidth: number,
    color: string | undefined,
    rotation?: { angle: number; originX: number; originY: number }
  ): void {
    const strokeWidth = Math.max(1, fontSize * 0.08);
    let totalGlyphW = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
      totalGlyphW += glyph ? glyph.w : 0.4;
    }
    const scale = totalGlyphW > 0 ? textWidth / (totalGlyphW * fontSize) : 1;

    if (!rotation || rotation.angle === 0) {
      let cx = startX;
      for (const ch of text) {
        const code = ch.codePointAt(0)!;
        const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
        if (glyph) {
          for (const stroke of glyph.d) {
            for (let j = 1; j < stroke.length; j++) {
              const x1 = cx + stroke[j - 1][0] * fontSize * scale;
              const y1 = y - fontSize * 0.75 + stroke[j - 1][1] * fontSize;
              const x2 = cx + stroke[j][0] * fontSize * scale;
              const y2 = y - fontSize * 0.75 + stroke[j][1] * fontSize;
              this.drawLine(x1, y1, x2, y2, color, strokeWidth);
            }
          }
          cx += glyph.w * fontSize * scale;
        }
      }
      return;
    }
    const theta = (rotation.angle * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ox = rotation.originX;
    const oy = rotation.originY;
    const rotate = (px: number, py: number): [number, number] => {
      const dx = px - ox;
      const dy = py - oy;
      return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos];
    };
    let cx = startX;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
      if (glyph) {
        for (const stroke of glyph.d) {
          for (let j = 1; j < stroke.length; j++) {
            const px1 = cx + stroke[j - 1][0] * fontSize * scale;
            const py1 = y - fontSize * 0.75 + stroke[j - 1][1] * fontSize;
            const px2 = cx + stroke[j][0] * fontSize * scale;
            const py2 = y - fontSize * 0.75 + stroke[j][1] * fontSize;
            const [rx1, ry1] = rotate(px1, py1);
            const [rx2, ry2] = rotate(px2, py2);
            this.drawLine(rx1, ry1, rx2, ry2, color, strokeWidth);
          }
        }
        cx += glyph.w * fontSize * scale;
      }
    }
  }

  private setPixel(x: number, y: number, rgba: [number, number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const i = (y * this.width + x) * 4;
    const alpha = rgba[3] / 255;
    const inverse = 1 - alpha;
    this.data[i] = Math.round(rgba[0] * alpha + this.data[i] * inverse);
    this.data[i + 1] = Math.round(rgba[1] * alpha + this.data[i + 1] * inverse);
    this.data[i + 2] = Math.round(rgba[2] * alpha + this.data[i + 2] * inverse);
    this.data[i + 3] = Math.round(rgba[3] + this.data[i + 3] * inverse);
  }
}

function parseSvgAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Manual parser avoids regex backtracking on uncontrolled input.
  let i = 0;
  const len = tag.length;
  while (i < len) {
    // Skip non-name characters
    while (i < len && !isNameChar(tag.charCodeAt(i))) {
      i++;
    }
    if (i >= len) {
      break;
    }
    // Read attribute name
    const nameStart = i;
    while (i < len && isNameChar(tag.charCodeAt(i))) {
      i++;
    }
    const name = tag.slice(nameStart, i);
    // Expect `="`
    if (i >= len || tag.charCodeAt(i) !== 61 /* = */) {
      continue;
    }
    i++;
    if (i >= len || tag.charCodeAt(i) !== 34 /* " */) {
      continue;
    }
    i++;
    // Read attribute value until closing quote
    const valStart = i;
    while (i < len && tag.charCodeAt(i) !== 34) {
      i++;
    }
    attrs[name] = tag.slice(valStart, i);
    if (i < len) {
      i++; // skip closing quote
    }
  }
  return attrs;
}

/** Check if a char code is valid in an SVG/XML attribute name (word chars, colon, hyphen). */
function isNameChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 || // _
    c === 58 || // :
    c === 45 // -
  );
}

/**
 * Parse the `rotate(angle [x y])` form of an SVG transform attribute.
 *
 * The chart renderer emits rotation on text exclusively as
 * `transform="rotate(angle x y)"` (see renderSvgText), so a minimal parser
 * is sufficient. Returns `undefined` for any other transform shape — the
 * Node PNG fallback is deliberately narrow in scope, not a general SVG
 * engine. Missing origin coordinates default to 0/0 per SVG semantics.
 */
function parseSvgRotateTransform(
  transform: string | undefined
): { angle: number; originX: number; originY: number } | undefined {
  if (!transform) {
    return undefined;
  }
  // Parse `rotate(angle)` or `rotate(angle, cx, cy)` using indexOf + split
  // to avoid regex backtracking on overlapping \s* quantifiers.
  const rotIdx = transform.indexOf("rotate(");
  if (rotIdx < 0) {
    return undefined;
  }
  const closeIdx = transform.indexOf(")", rotIdx);
  if (closeIdx < 0) {
    return undefined;
  }
  const inner = transform.slice(rotIdx + 7, closeIdx).trim();
  const parts = inner.split(/[\s,]+/);
  const angle = Number.parseFloat(parts[0]);
  if (!Number.isFinite(angle) || angle === 0) {
    return undefined;
  }
  const originX = parts.length >= 3 ? Number.parseFloat(parts[1]) : 0;
  const originY = parts.length >= 3 ? Number.parseFloat(parts[2]) : 0;
  return { angle, originX, originY };
}

function numAttr(
  attrs: Record<string, string>,
  name: string,
  fallback = 0,
  percentBase?: number
): number {
  const value = attrs[name];
  if (value === undefined) {
    return fallback;
  }
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent) && percentBase !== undefined
      ? (percent / 100) * percentBase
      : fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSvgPoints(input: string | undefined, scale = 1): ChartScenePoint[] {
  if (!input) {
    return [];
  }
  const values = input
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  const points: ChartScenePoint[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    points.push({ x: values[i] * scale, y: values[i + 1] * scale });
  }
  return points;
}

function parsePathPoints(input: string | undefined, scale = 1): ChartScenePoint[] {
  if (!input) {
    return [];
  }
  // Accept both upper and lower-case SVG commands; we lowercase via
  // `toUpperCase` below, treating relative and absolute forms the
  // same (caller supplies paths the renderer itself emits, which are
  // always absolute — the tolerance is for third-party author-shape
  // round-trips).
  const tokens = input.match(/[MLAZ]|-?\d+(?:\.\d+)?/gi) ?? [];
  const points: ChartScenePoint[] = [];
  let i = 0;
  let current: ChartScenePoint | undefined;
  let start: ChartScenePoint | undefined;
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase();
    if (command === "M" || command === "L") {
      const point = readPathPoint(tokens, i);
      i += 2;
      if (!point) {
        // Malformed M/L — skip its two parameter tokens (already
        // advanced) and continue walking the rest of the path. The
        // previous `break` abandoned every subsequent command,
        // silently dropping half a path for a single bad coordinate.
        continue;
      }
      point.x *= scale;
      point.y *= scale;
      current = point;
      start ??= point;
      points.push(point);
    } else if (command === "A") {
      // An `A` command consumes seven parameter tokens regardless of
      // whether the arc is successfully decoded. Advance the cursor
      // up front so a malformed arc doesn't strand the parser on its
      // own parameter list.
      if (!current) {
        i += 7;
        continue;
      }
      const arc = readPathArc(tokens, i, current, scale);
      i += 7;
      if (!arc) {
        continue;
      }
      for (const p of arc.points) {
        points.push(p);
      }
      current = arc.end;
    } else if (command === "Z") {
      if (start) {
        points.push(start);
      }
    } else {
      // Unrecognised command — try to reinterpret the token as an
      // implicit coordinate pair (SVG allows repeated coordinates
      // after an `M` / `L`, e.g. `M 1 2 3 4` draws an implicit
      // lineTo from (1,2) to (3,4)).
      const numeric = Number.parseFloat(command);
      if (!Number.isFinite(numeric) || i >= tokens.length) {
        // Genuinely unknown token — skip and keep walking instead
        // of abandoning the rest of the path.
        continue;
      }
      const y = Number.parseFloat(tokens[i]);
      if (!Number.isFinite(y)) {
        continue;
      }
      i++;
      current = { x: numeric * scale, y: y * scale };
      start ??= current;
      points.push(current);
    }
  }
  return points;
}

function readPathPoint(tokens: string[], index: number): ChartScenePoint | undefined {
  const x = Number.parseFloat(tokens[index]);
  const y = Number.parseFloat(tokens[index + 1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function readPathArc(
  tokens: string[],
  index: number,
  from: ChartScenePoint,
  scale: number
): { end: ChartScenePoint; points: ChartScenePoint[] } | undefined {
  const rx = Number.parseFloat(tokens[index]);
  const ry = Number.parseFloat(tokens[index + 1]);
  const largeArc = Number.parseFloat(tokens[index + 3]) === 1;
  const sweep = Number.parseFloat(tokens[index + 4]) === 1;
  const end = readPathPoint(tokens, index + 5);
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !end) {
    return undefined;
  }
  end.x *= scale;
  end.y *= scale;
  return {
    end,
    points: approximateArcPoints(from, end, Math.max(rx, ry) * scale, largeArc, sweep)
  };
}

function approximateArcPoints(
  start: ChartScenePoint,
  end: ChartScenePoint,
  radius: number,
  largeArc: boolean,
  sweep: boolean
): ChartScenePoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(radius) || radius <= 0 || chord === 0 || chord > radius * 2) {
    return [end];
  }
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const halfChord = chord / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));
  const nx = -dy / chord;
  const ny = dx / chord;
  // When the chord equals the diameter (`h ≈ 0` for a half-circle)
  // both candidate centres coincide at the midpoint and produce
  // `|delta| ≈ π`. The strict inequality `|delta| > π === largeArc`
  // treats both as "not large", so the selected centre was identical
  // regardless of `largeArc`, making a semicircle traced the wrong
  // way round for `largeArc=true`. Use the SVG endpoint→centre
  // parametrisation for this degenerate case and fall back to the
  // chord-bisector approach otherwise.
  const candidates = [
    { x: mx + nx * h, y: my + ny * h },
    { x: mx - nx * h, y: my - ny * h }
  ];
  // Prefer the candidate whose resulting arc length matches
  // `largeArc`. Use `>=` so the exact-π boundary sorts with
  // `largeArc=true` instead of `false`; combined with the
  // `sweep` tie-breaker below, this routes a true semicircle to the
  // candidate whose winding direction matches `sweep`.
  let selected = candidates[0];
  let bestScore = -Infinity;
  for (const center of candidates) {
    const delta = arcDelta(center, start, end, sweep);
    const isLarge = Math.abs(delta) >= Math.PI - 1e-9;
    // Score 2 when this candidate's large-arc classification agrees
    // with the requested `largeArc`; score 1 as a half-match when we
    // are exactly on the boundary (the `Math.abs(delta) - π` is near
    // zero); score 0 otherwise. Picking the highest score gives us
    // the disambiguation we need for semicircles without breaking
    // non-boundary cases.
    const score = isLarge === largeArc ? 2 : 1 - Math.abs(Math.abs(delta) - Math.PI);
    if (score > bestScore) {
      bestScore = score;
      selected = center;
    }
  }
  const startAngle = Math.atan2(start.y - selected.y, start.x - selected.x);
  const delta = arcDelta(selected, start, end, sweep);
  const steps = clampInt(Math.ceil((Math.abs(delta) * radius) / 3), 12, 180);
  const points: ChartScenePoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const angle = startAngle + (delta * i) / steps;
    points.push({
      x: selected.x + Math.cos(angle) * radius,
      y: selected.y + Math.sin(angle) * radius
    });
  }
  return points;
}

function arcDelta(
  center: ChartScenePoint,
  start: ChartScenePoint,
  end: ChartScenePoint,
  sweep: boolean
): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  let delta = endAngle - startAngle;
  if (sweep && delta < 0) {
    delta += Math.PI * 2;
  } else if (!sweep && delta > 0) {
    delta -= Math.PI * 2;
  }
  return delta;
}

function parseSvgColor(color: string | undefined): [number, number, number, number] | undefined {
  if (!color || color === "none" || color === "transparent") {
    return undefined;
  }
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    return [
      Number.parseInt(normalized[0] + normalized[0], 16),
      Number.parseInt(normalized[1] + normalized[1], 16),
      Number.parseInt(normalized[2] + normalized[2], 16),
      255
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
      255
    ];
  }
  // `#RRGGBBAA` — OOXML encodes alpha inside the srgb hex for some
  // generators, and `resolveChartColor` lets the 8-digit form through
  // with alpha stripped for SVG (browsers parse `#RRGGBBAA` natively).
  // The PNG fallback raster used to reject 8-digit hex → every
  // `<a:srgbClr val="RRGGBBAA"/>`-coloured shape silently vanished
  // from the rasterised output.
  if (/^[0-9a-fA-F]{8}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
      Number.parseInt(normalized.slice(6, 8), 16)
    ];
  }
  // `#RGBA` — 4-digit shorthand mirrors `#RGB` with a nibble-alpha.
  if (/^[0-9a-fA-F]{4}$/.test(normalized)) {
    return [
      Number.parseInt(normalized[0] + normalized[0], 16),
      Number.parseInt(normalized[1] + normalized[1], 16),
      Number.parseInt(normalized[2] + normalized[2], 16),
      Number.parseInt(normalized[3] + normalized[3], 16)
    ];
  }
  return undefined;
}

function decodeSvgText(value: string): string {
  // Strip SVG markup in a single O(n) pass to avoid polynomial complexity
  // from repeated regex replacements on nested incomplete tags.
  let stripped = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 60 /* < */) {
      depth++;
    } else if (ch === 62 /* > */) {
      if (depth > 0) {
        depth--;
      } else {
        stripped += ">";
      }
    } else if (depth === 0) {
      stripped += value[i];
    }
  }
  return stripped.replace(
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function encodePng(width: number, height: number, rgba: Uint8Array, dpi?: number): Uint8Array {
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    scanlines[dst] = 0;
    scanlines.set(rgba.subarray(src, src + width * 4), dst + 1);
  }
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(
    pngChunk("IHDR", concatBytes([u32be(width), u32be(height), new Uint8Array([8, 6, 0, 0, 0])]))
  );
  if (dpi !== undefined) {
    const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254));
    chunks.push(
      pngChunk(
        "pHYs",
        concatBytes([u32be(pixelsPerMeter), u32be(pixelsPerMeter), new Uint8Array([1])])
      )
    );
  }
  chunks.push(pngChunk("IDAT", zlibStored(scanlines)));
  chunks.push(pngChunk("IEND", new Uint8Array()));
  return concatBytes(chunks);
}

function normalizePngScale(scale: number | undefined): number {
  if (scale === undefined) {
    return 1;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("chart render scale must be a positive finite number");
  }
  return Math.min(8, scale);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = concatBytes([typeBytes, data]);
  return concatBytes([u32be(data.length), typeBytes, data, u32be(crc32Bytes(crcInput))]);
}

function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  while (offset < data.length) {
    const len = Math.min(0xffff, data.length - offset);
    const final = offset + len >= data.length ? 1 : 0;
    blocks.push(
      new Uint8Array([final, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff])
    );
    blocks.push(data.subarray(offset, offset + len));
    offset += len;
  }
  blocks.push(u32be(adler32(data)));
  return concatBytes(blocks);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32Bytes(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function drawChartPdf(
  page: ChartPdfDrawingSurface,
  model: ChartModel,
  options: PdfChartRenderOptions
): ChartPdfDrawingSurface {
  const scene = translateScene(buildChartScene(model, options), options.x, options.y, true);
  const trace = options.trace;
  trace?.push(
    `canvas:${fmt(scene.width)}x${fmt(scene.height)}@${fmt(options.x)},${fmt(options.y)}`
  );
  page.drawRect({
    x: options.x,
    y: options.y,
    width: scene.width,
    height: scene.height,
    fill: { r: 1, g: 1, b: 1 },
    stroke: { r: 0.8, g: 0.8, b: 0.8 }
  });
  if (scene.title) {
    trace?.push(`text:title:${scene.title.text}:${fmt(scene.title.x)},${fmt(scene.title.y)}`);
    drawPdfText(page, scene.title, { anchorOverride: "middle" });
  }
  for (const gridline of scene.gridlines) {
    trace?.push(
      `line:grid:${fmt(gridline.x1)},${fmt(gridline.y1)}-${fmt(gridline.x2)},${fmt(gridline.y2)}`
    );
    page.drawLine({ ...gridline, color: hexToPdfColor(gridline.color) });
  }
  if (scene.axes.x) {
    trace?.push(
      `line:x:${fmt(scene.axes.x.x1)},${fmt(scene.axes.x.y1)}-${fmt(scene.axes.x.x2)},${fmt(scene.axes.x.y2)}`
    );
    page.drawLine({ ...scene.axes.x, color: hexToPdfColor(scene.axes.x.color) });
  }
  if (scene.axes.y) {
    trace?.push(
      `line:y:${fmt(scene.axes.y.x1)},${fmt(scene.axes.y.y1)}-${fmt(scene.axes.y.x2)},${fmt(scene.axes.y.y2)}`
    );
    page.drawLine({ ...scene.axes.y, color: hexToPdfColor(scene.axes.y.color) });
  }
  if (scene.axes.x2) {
    trace?.push(
      `line:x2:${fmt(scene.axes.x2.x1)},${fmt(scene.axes.x2.y1)}-${fmt(scene.axes.x2.x2)},${fmt(scene.axes.x2.y2)}`
    );
    page.drawLine({ ...scene.axes.x2, color: hexToPdfColor(scene.axes.x2.color) });
  }
  if (scene.axes.y2) {
    trace?.push(
      `line:y2:${fmt(scene.axes.y2.x1)},${fmt(scene.axes.y2.y1)}-${fmt(scene.axes.y2.x2)},${fmt(scene.axes.y2.y2)}`
    );
    page.drawLine({ ...scene.axes.y2, color: hexToPdfColor(scene.axes.y2.color) });
  }
  for (const label of [
    ...scene.xLabels,
    ...scene.yLabels,
    ...scene.secondaryXLabels,
    ...scene.secondaryYLabels,
    ...scene.axisTitles
  ]) {
    trace?.push(`text:label:${label.text}:${fmt(label.x)},${fmt(label.y)}`);
    drawPdfText(page, label);
  }
  // Two-pass rendering: every series' shapes first, then every
  // series' adornments. Same fix as the SVG path — see the matching
  // comment in `renderChartSvg`. Single-pass (shapes + adornments
  // together per series) lets the next series' filled shapes paint
  // over the previous series' data labels and trendlines.
  for (const s of scene.series) {
    trace?.push(`series:${s.type}`);
    drawPdfSeries(page, s);
  }
  for (const s of scene.series) {
    drawPdfAdornments(page, s, trace);
  }
  if (scene.dataTable) {
    drawPdfDataTable(page, scene.dataTable, trace);
  }
  trace?.push(
    `legend:${scene.legend.visible ? "visible" : "hidden"}:${scene.legend.items.map(item => item.label).join("|")}`
  );
  drawPdfLegend(page, scene.legend);
  return page;
}

/**
 * Draw a {@link ChartSceneText} through the PDF surface.
 *
 * Translates the scene's `anchor` / `rotate` / `color` fields into the
 * extended `ChartPdfDrawingSurface.drawText` parameters, and for surfaces
 * that ignore those new fields pre-shifts `x` using the same font
 * metrics the SVG path uses (`estimateTextWidth`). The result is that
 * legacy `drawText(text, { x, y, fontSize })` implementations continue
 * to render text at the correct horizontal position, while an upgraded
 * surface (such as `PdfPageBuilder`) can perform a proper measured
 * alignment with rotation.
 *
 * `anchorOverride` lets callers (e.g. the title) force a particular
 * anchor regardless of what the scene produced — useful where the
 * layout code already centres `x` around the midpoint but we still
 * want the text glyphs centred.
 */
function drawPdfText(
  page: ChartPdfDrawingSurface,
  text: ChartSceneText,
  extra: { anchorOverride?: "start" | "middle" | "end" } = {}
): void {
  const anchor = extra.anchorOverride ?? text.anchor ?? "start";
  // Pass the true anchor point `text.x` and the `anchor` hint to the
  // surface unchanged. Modern library surfaces (`PdfPageBuilder`,
  // canvas rasteriser) honour `anchor` by measuring the text and
  // shifting internally. Legacy surfaces that predate the `anchor`
  // parameter are documented to ignore it and render as if anchor
  // were `"start"`; callers with such surfaces accept the
  // approximate alignment.
  //
  // The previous code ALSO pre-shifted `x` by `-width * anchorBias`
  // before passing `anchor` through. Surfaces that honour `anchor`
  // then shifted a second time, producing `text.x - width` for a
  // `"middle"`-anchored label (i.e., the text landed one glyph-width
  // to the left of the correct anchor point). The comment on the
  // old implementation claimed "supplying both is safe" but the
  // arithmetic was double-compensation: the surface's own measurement
  // yielded the same width, so the two shifts stacked instead of
  // cancelling.
  page.drawText(text.text, {
    x: text.x,
    y: text.y,
    fontSize: text.fontSize,
    color: text.color ? hexToPdfColor(text.color) : undefined,
    rotation: text.rotate,
    anchor,
    fontFamily: text.fontFamily,
    bold: text.bold,
    italic: text.italic
  });
}

/**
 * Draw series-level adornments: leader lines, error bars, trendlines,
 * markers, data labels, and the bar3D depth hint. The SVG path handles
 * all of these via {@link renderSvgAdornments}; this is the matching
 * PDF implementation. Optional `trace` entries mirror the SVG tag names
 * so golden assertions can verify presence without binding to exact
 * coordinates.
 */
function drawPdfAdornments(
  page: ChartPdfDrawingSurface,
  series: ChartSceneSeries,
  trace?: string[]
): void {
  const color = "color" in series ? hexToPdfColor(series.color) : { r: 0.3, g: 0.3, b: 0.3 };
  // Leader lines (pie/doughnut external labels). Emit before the labels
  // themselves so the glyphs sit on top visually.
  for (const leader of series.leaderLines ?? []) {
    trace?.push(`leader:${fmt(leader.x1)},${fmt(leader.y1)}-${fmt(leader.x2)},${fmt(leader.y2)}`);
    page.drawLine({
      x1: leader.x1,
      y1: leader.y1,
      x2: leader.x2,
      y2: leader.y2,
      color: hexToPdfColor(leader.color),
      lineWidth: leader.width ?? 1
    });
  }
  // Error bars
  for (const eb of series.errorBars ?? []) {
    trace?.push(
      `errorbar:${fmt(eb.line.x1)},${fmt(eb.line.y1)}-${fmt(eb.line.x2)},${fmt(eb.line.y2)}`
    );
    page.drawLine({
      x1: eb.line.x1,
      y1: eb.line.y1,
      x2: eb.line.x2,
      y2: eb.line.y2,
      color: hexToPdfColor(eb.line.color),
      lineWidth: eb.line.width ?? 1
    });
    for (const cap of [eb.cap1, eb.cap2]) {
      if (cap) {
        page.drawLine({
          x1: cap.x1,
          y1: cap.y1,
          x2: cap.x2,
          y2: cap.y2,
          color: hexToPdfColor(cap.color),
          lineWidth: cap.width ?? 1
        });
      }
    }
  }
  // Trendlines — polyline over the precomputed points, plus an optional
  // label at the end. The SVG variant uses `stroke-dasharray="4 3"`
  // whenever `dash` is set; mirror that as a simple on/off dash pattern.
  // Segment the polyline at NaN gaps (moving-average trendlines can
  // emit NaN points for leading positions before the window fills) so
  // the PDF matches the SVG `segmentFinitePoints` treatment.
  for (const trend of series.trendlines ?? []) {
    trace?.push(`trendline:${trend.points.length}pts`);
    const dashPattern = trend.dash ? [4, 3] : undefined;
    for (const segment of segmentFinitePoints(trend.points)) {
      for (let i = 1; i < segment.length; i++) {
        const p0 = segment[i - 1];
        const p1 = segment[i];
        page.drawLine({
          x1: p0.x,
          y1: p0.y,
          x2: p1.x,
          y2: p1.y,
          color: hexToPdfColor(trend.color),
          lineWidth: trend.width ?? 1.5,
          dashPattern
        });
      }
    }
    if (trend.label) {
      drawPdfText(page, trend.label);
    }
  }
  // Markers — geometric symbols at each point. Mirrors renderSvgMarker.
  for (const marker of series.markers ?? []) {
    drawPdfMarker(page, marker);
  }
  // Data labels (post-collision-resolution, post-leader-line layout).
  for (const label of series.labels ?? []) {
    trace?.push(`label:${label.text}:${fmt(label.x)},${fmt(label.y)}`);
    drawPdfText(page, label);
  }
  // bar3D's decorative depth hint: two parallelograms projected along
  // (+depth, -depth) for every bar. The PDF path does the same thing
  // using `drawPath` when available; surfaces without `drawPath` fall
  // back to drawing the two parallelograms as pairs of lines, which
  // preserves the 3D illusion even without filled polygons.
  //
  // `buildSceneSeries` sets `depth > 0` only when `projection3D` is
  // also present (see the `bar3DDepth` ternary at line 2880), so the
  // previous `else if (depth && !projection3D)` branch that called
  // `drawPdfBarDepth` was structurally unreachable. Dropped along
  // with its SVG counterpart; the remaining 3D path covers every
  // bar3D configuration the builder emits.
  if (series.type === "bar" && series.depth && series.depth > 0 && series.projection3D) {
    for (const bar of series.bars) {
      drawPdfBar3DBox(page, bar, series.projection3D, color, series.horizontal);
    }
  }
  // Radar's translucent fill is emitted by `drawPdfSeries` itself (the
  // filled radar branch `chart-renderer.ts:4139-4146`) using
  // `hexToPdfColorWithAlpha`, so no additional adornment pass is needed
  // here. Surfaces without drawPath degrade to stroke-only, which the
  // same branch also handles.
}

function drawPdfMarker(page: ChartPdfDrawingSurface, marker: ChartSceneMarker): void {
  const r = marker.size / 2;
  const fill = hexToPdfColor(marker.color);
  const symbol = marker.symbol ?? "circle";
  if (symbol === "square") {
    page.drawRect({
      x: marker.x - r,
      y: marker.y - r,
      width: marker.size,
      height: marker.size,
      fill
    });
    return;
  }
  if (symbol === "diamond") {
    if (page.drawPath) {
      page.drawPath(
        [
          { op: "move", x: marker.x, y: marker.y - r },
          { op: "line", x: marker.x + r, y: marker.y },
          { op: "line", x: marker.x, y: marker.y + r },
          { op: "line", x: marker.x - r, y: marker.y },
          { op: "close" }
        ],
        { fill }
      );
      return;
    }
    // Fall back to a stroked-outline diamond when the surface lacks
    // `drawPath`. A circle fallback (the old behaviour) loses the
    // shape identity — four lines preserve the diamond's silhouette
    // at the cost of the fill.
    page.drawLine({ x1: marker.x, y1: marker.y - r, x2: marker.x + r, y2: marker.y, color: fill });
    page.drawLine({ x1: marker.x + r, y1: marker.y, x2: marker.x, y2: marker.y + r, color: fill });
    page.drawLine({ x1: marker.x, y1: marker.y + r, x2: marker.x - r, y2: marker.y, color: fill });
    page.drawLine({ x1: marker.x - r, y1: marker.y, x2: marker.x, y2: marker.y - r, color: fill });
    return;
  }
  if (symbol === "triangle") {
    if (page.drawPath) {
      page.drawPath(
        [
          { op: "move", x: marker.x, y: marker.y - r },
          { op: "line", x: marker.x + r, y: marker.y + r },
          { op: "line", x: marker.x - r, y: marker.y + r },
          { op: "close" }
        ],
        { fill }
      );
      return;
    }
    // Stroked-outline triangle fallback for surfaces without `drawPath`.
    page.drawLine({
      x1: marker.x,
      y1: marker.y - r,
      x2: marker.x + r,
      y2: marker.y + r,
      color: fill
    });
    page.drawLine({
      x1: marker.x + r,
      y1: marker.y + r,
      x2: marker.x - r,
      y2: marker.y + r,
      color: fill
    });
    page.drawLine({
      x1: marker.x - r,
      y1: marker.y + r,
      x2: marker.x,
      y2: marker.y - r,
      color: fill
    });
    return;
  }
  if (symbol === "x") {
    page.drawLine({
      x1: marker.x - r,
      y1: marker.y - r,
      x2: marker.x + r,
      y2: marker.y + r,
      color: fill,
      lineWidth: 2
    });
    page.drawLine({
      x1: marker.x + r,
      y1: marker.y - r,
      x2: marker.x - r,
      y2: marker.y + r,
      color: fill,
      lineWidth: 2
    });
    return;
  }
  if (symbol === "plus") {
    page.drawLine({
      x1: marker.x - r,
      y1: marker.y,
      x2: marker.x + r,
      y2: marker.y,
      color: fill,
      lineWidth: 2
    });
    page.drawLine({
      x1: marker.x,
      y1: marker.y - r,
      x2: marker.x,
      y2: marker.y + r,
      color: fill,
      lineWidth: 2
    });
    return;
  }
  // Default / circle / dash / dot / star / picture / auto — fall back to
  // a filled circle so at least the point is visible.
  if (page.drawCircle) {
    page.drawCircle({ cx: marker.x, cy: marker.y, r, fill });
  } else {
    page.drawRect({
      x: marker.x - r,
      y: marker.y - r,
      width: marker.size,
      height: marker.size,
      fill
    });
  }
}

/**
 * Render a bar3D column as a true extruded box via the PDF surface.
 * Mirrors {@link renderBar3DBox} for SVG — three visible faces with
 * light/dark shading. Surfaces without `drawPath` fall back to stroked
 * outlines so the 3D cue is preserved even without filled polygons.
 */
function drawPdfBar3DBox(
  page: ChartPdfDrawingSurface,
  bar: ChartSceneRect,
  proj: { dx: number; dy: number },
  baseColor: PdfColor,
  horizontal: boolean | undefined
): void {
  const dx = proj.dx;
  const dy = proj.dy;
  const right = bar.x + bar.width;
  const top = bar.y;
  const bottom = bar.y + bar.height;
  const topFill: PdfColor = { r: baseColor.r, g: baseColor.g, b: baseColor.b, a: 0.92 };
  const rightFill: PdfColor = { r: baseColor.r, g: baseColor.g, b: baseColor.b, a: 0.75 };
  const topFace: ChartPdfPathOp[] = [
    { op: "move", x: bar.x, y: top },
    { op: "line", x: bar.x + dx, y: top - dy },
    { op: "line", x: right + dx, y: top - dy },
    { op: "line", x: right, y: top },
    { op: "close" }
  ];
  const rightFace: ChartPdfPathOp[] = [
    { op: "move", x: right, y: top },
    { op: "line", x: right + dx, y: top - dy },
    { op: "line", x: right + dx, y: bottom - dy },
    { op: "line", x: right, y: bottom },
    { op: "close" }
  ];
  void horizontal; // same geometry regardless — kept for future tuning
  if (page.drawPath) {
    page.drawPath(topFace, { fill: topFill });
    page.drawPath(rightFace, { fill: rightFill });
    page.drawRect({ x: bar.x, y: top, width: bar.width, height: bar.height, fill: baseColor });
    return;
  }
  for (const ops of [topFace, rightFace]) {
    for (let i = 1; i < ops.length; i++) {
      const a = ops[i - 1];
      const b = ops[i];
      if (a.op === "close" || b.op === "close") {
        continue;
      }
      if ("x" in a && "y" in a && "x" in b && "y" in b) {
        page.drawLine({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: rightFill });
      }
    }
  }
  page.drawRect({ x: bar.x, y: top, width: bar.width, height: bar.height, fill: baseColor });
}

function getPlotRect(
  width: number,
  height: number,
  hasTitle: boolean,
  legend: ChartSceneLegend,
  model: ChartModel,
  dataTableHeight = 0,
  categoryCount = 0
): ChartSceneRect {
  const axes = model.chart.plotArea.axes;
  const leftAxis = axes.find(axis => !axis.delete && axis.axPos === "l");
  const rightAxis = axes.find(axis => !axis.delete && axis.axPos === "r");
  const topAxis = axes.find(axis => !axis.delete && axis.axPos === "t");
  const bottomAxis = axes.find(axis => !axis.delete && axis.axPos === "b");
  // Legend padding is derived from the real scene rectangle so long series
  // names push the plot rectangle inwards instead of being clipped by it.
  // `legend.rect.width` was sized by `legendRect` from actual label widths.
  //
  // `model.chart.legend.overlay === true` instructs Excel to paint the
  // legend on top of the plot area instead of reserving space for it.
  // Previously the renderer always reserved space, silently shrinking
  // the plot even when the author explicitly asked for an overlay
  // legend.
  const legendReserves = legend.visible && !(model.chart.legend?.overlay === true);
  const leftLegendPad =
    legendReserves && legend.position === "l" ? legend.rect.width + LEGEND_GAP_LEFT : 0;
  const rightLegendPad =
    legendReserves && (legend.position === "r" || legend.position === "tr")
      ? legend.rect.width + LEGEND_GAP_RIGHT
      : 0;
  const left = PLOT_MARGIN_LEFT + (leftAxis?.title ? PLOT_AXIS_TITLE_PADDING : 0) + leftLegendPad;
  const right =
    PLOT_MARGIN_RIGHT +
    (rightAxis ? PLOT_SECONDARY_AXIS_WIDTH : 0) +
    (rightAxis?.title ? PLOT_AXIS_TITLE_PADDING : 0) +
    rightLegendPad;
  const top =
    (hasTitle ? PLOT_MARGIN_TOP_WITH_TITLE : PLOT_MARGIN_TOP_NO_TITLE) +
    (topAxis ? PLOT_TOP_AXIS_HEIGHT : 0) +
    (topAxis?.title ? PLOT_TOP_AXIS_TITLE_HEIGHT : 0) +
    (legendReserves && legend.position === "t" ? PLOT_TOP_LEGEND_PADDING : 0);
  // Bottom-margin budget:
  //
  //   * PLOT_MARGIN_BOTTOM px base (chart-edge padding + a safety margin
  //     for stroke rounding on the axis line).
  //   * PLOT_BOTTOM_AXIS_LABEL_HEIGHT px for axis tick labels — reserved
  //     when a bottom axis exists AND its labels are actually emitted.
  //     When a data table replaces the category labels
  //     (`buildChartScene` suppresses them in that case) we reclaim the
  //     space so the data table's own header doesn't push the plot up
  //     unnecessarily.
  //   * Optional bottom-axis title.
  //   * Optional legend at `b` (only when the legend does not overlay).
  //   * Data-table footprint.
  // Bottom label space depends on whether categories will be rotated.
  // The renderer rotates labels when categoryCount > 6 (see
  // buildCategoryLabels). Rotated labels need more vertical space,
  // but we cap at 20% of chart height to avoid squishing the plot.
  // Non-rotated labels only need the fixed PLOT_BOTTOM_AXIS_LABEL_HEIGHT.
  const labelsRotated = categoryCount > 6;
  const bottomLabelSpace =
    bottomAxis && dataTableHeight === 0
      ? labelsRotated
        ? Math.min(Math.max(PLOT_BOTTOM_AXIS_LABEL_HEIGHT, height * 0.15), height * 0.2)
        : PLOT_BOTTOM_AXIS_LABEL_HEIGHT
      : 0;
  const bottom =
    PLOT_MARGIN_BOTTOM +
    bottomLabelSpace +
    (bottomAxis?.title ? PLOT_AXIS_TITLE_PADDING : 0) +
    (legendReserves && legend.position === "b" ? PLOT_BOTTOM_LEGEND_PADDING : 0) +
    dataTableHeight;
  const auto: ChartSceneRect = {
    x: left,
    y: top,
    width: Math.max(PLOT_MIN_DIMENSION, width - left - right),
    height: Math.max(PLOT_MIN_DIMENSION, height - top - bottom)
  };
  const manual = model.chart.plotArea.layout?.manualLayout;
  if (!manual) {
    return auto;
  }
  return applyManualPlotLayout(auto, manual, width, height);
}

/**
 * Apply a plotArea `c:layout/c:manualLayout` override to the auto-computed
 * plot rectangle. Only `edge`-mode positioning/sizing is honoured; `factor`
 * mode is documented by the OOXML spec as a ratio relative to the default
 * Excel layout, which this deterministic preview does not compute because
 * the default itself is approximate (`auto`). Undefined axes fall back to
 * the auto value so partial overrides (e.g. custom width only) work.
 * `layoutTarget` is treated as `inner` in all cases — the preview renderer
 * does not yet draw axis labels outside the plot rectangle, so `outer`
 * behaves identically.
 */
function applyManualPlotLayout(
  auto: ChartSceneRect,
  manual: NonNullable<NonNullable<ChartModel["chart"]["plotArea"]["layout"]>["manualLayout"]>,
  chartWidth: number,
  chartHeight: number
): ChartSceneRect {
  const resolveX = (v: number | undefined, mode: "edge" | "factor" | undefined): number =>
    v !== undefined && mode !== "factor" ? clamp01(v) * chartWidth : auto.x;
  const resolveY = (v: number | undefined, mode: "edge" | "factor" | undefined): number =>
    v !== undefined && mode !== "factor" ? clamp01(v) * chartHeight : auto.y;
  const resolveW = (v: number | undefined, mode: "edge" | "factor" | undefined): number =>
    v !== undefined && mode !== "factor" ? clamp01(v) * chartWidth : auto.width;
  const resolveH = (v: number | undefined, mode: "edge" | "factor" | undefined): number =>
    v !== undefined && mode !== "factor" ? clamp01(v) * chartHeight : auto.height;

  const x = resolveX(manual.x, manual.xMode);
  const y = resolveY(manual.y, manual.yMode);
  const w = Math.max(10, resolveW(manual.w, manual.wMode));
  const h = Math.max(10, resolveH(manual.h, manual.hMode));
  // Clamp against the chart canvas so pathological values don't draw off-screen.
  const clampedX = Math.max(0, Math.min(x, chartWidth - 10));
  const clampedY = Math.max(0, Math.min(y, chartHeight - 10));
  const clampedW = Math.min(w, chartWidth - clampedX);
  const clampedH = Math.min(h, chartHeight - clampedY);
  return { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
}

// ============================================================================
// Data table (c:dTable) layout
// ============================================================================

const DATA_TABLE_ROW_HEIGHT_DEFAULT = 18;
const DATA_TABLE_FONT_SIZE_DEFAULT = 10;
const DATA_TABLE_SWATCH_SIZE = 10;
const DATA_TABLE_NAME_COL_PADDING = 16;
const DATA_TABLE_CELL_PADDING_X = 6;
// Gap between plot baseline and the top of the data table.
const DATA_TABLE_TOP_GAP = 8;

/**
 * Vertical footprint of the data-table overlay, used by
 * {@link getPlotRect} to reserve bottom padding before series geometry
 * is computed. Counts the header row (categories) plus one row per
 * normalised series, each at {@link DATA_TABLE_ROW_HEIGHT_DEFAULT}
 * unless the author's `txPr` explicitly raises the font size.
 */
function computeDataTableHeight(
  table: DataTable,
  normalized: NormalizedSeries[],
  categories: string[]
): number {
  if (normalized.length === 0 || categories.length === 0) {
    return 0;
  }
  const fontSize = resolveDataTableFontSize(table);
  const rowHeight = Math.max(DATA_TABLE_ROW_HEIGHT_DEFAULT, Math.round(fontSize * 1.6));
  // Header (categories) + one row per series.
  const rowCount = 1 + normalized.length;
  return rowCount * rowHeight + DATA_TABLE_TOP_GAP;
}

function resolveDataTableFontSize(table: DataTable): number {
  const explicit = getTxPrFontSizePx(table.txPr);
  return explicit ?? DATA_TABLE_FONT_SIZE_DEFAULT;
}

function getTxPrFontSizePx(txPr: ChartTextProperties | undefined): number | undefined {
  if (!txPr) {
    return undefined;
  }
  // `getTxPrFontSize` returns points; convert to CSS pixels using the
  // 1 pt = 1.333 px rule so the result matches the rest of the
  // renderer's text sizing.
  const points = getTxPrFontSize(txPr);
  if (typeof points !== "number") {
    return undefined;
  }
  return points * (4 / 3);
}

/**
 * Build the scene-level layout for `c:dTable`. The table hugs the
 * plot's x-range so columns line up with category ticks even when the
 * legend or axis titles push the plot inward. The first column is a
 * series-name column sized to the widest label (+ swatch when
 * `showKeys` is on). Remaining columns are equal-width category cells.
 */
function buildSceneDataTable(
  table: DataTable,
  normalized: NormalizedSeries[],
  categories: string[],
  plot: ChartSceneRect,
  height: number
): ChartSceneDataTable | undefined {
  if (normalized.length === 0 || categories.length === 0 || height <= 0) {
    return undefined;
  }
  const fontSize = resolveDataTableFontSize(table);
  const rowHeight = (height - DATA_TABLE_TOP_GAP) / (1 + normalized.length);
  const color = colorFromChartTextProperties(table.txPr) ?? "#444444";
  const textStyle = textStyleFromTxPr(table.txPr);
  const showKeys = table.showKeys !== false;
  // Series-name column width — widest label + swatch + padding.
  const swatchWidth = showKeys ? DATA_TABLE_SWATCH_SIZE + 6 : 0;
  const maxNameWidth = normalized.reduce(
    (acc, s) =>
      Math.max(
        acc,
        estimateTextWidth(s.label || "", fontSize, {
          bold: textStyle.bold,
          italic: textStyle.italic,
          fontName: textStyle.fontFamily
        })
      ),
    0
  );
  const nameColWidth = Math.ceil(maxNameWidth + swatchWidth + DATA_TABLE_NAME_COL_PADDING);
  // Table's left edge sits just below the y-axis, so the name column
  // lives in the left margin. When the name column doesn't fit there
  // we still draw everything inside the chart width — overlapping a
  // little with the y-axis is preferable to clipping.
  const tableLeft = Math.max(4, plot.x - nameColWidth);
  const tableRight = plot.x + plot.width;
  const tableTop = plot.y + plot.height + DATA_TABLE_TOP_GAP;
  const rect: ChartSceneRect = {
    x: tableLeft,
    y: tableTop,
    width: tableRight - tableLeft,
    height: height - DATA_TABLE_TOP_GAP
  };
  // Column boundaries — name column + one per category evenly dividing
  // the plot's x range so ticks line up.
  const columns: number[] = [tableLeft, plot.x];
  const catWidth = plot.width / categories.length;
  for (let i = 1; i <= categories.length; i++) {
    columns.push(plot.x + catWidth * i);
  }
  // Row boundaries — header + one per series.
  const rows: number[] = [tableTop];
  for (let r = 1; r <= 1 + normalized.length; r++) {
    rows.push(tableTop + rowHeight * r);
  }

  const cells: ChartSceneText[] = [];
  const legendSwatches: Array<ChartSceneRect & { color: string }> = [];

  // Header row — category names, centred in each category column.
  for (let c = 0; c < categories.length; c++) {
    const cellX = columns[c + 1] + catWidth / 2;
    const cellY = rows[0] + rowHeight / 2 + fontSize / 3;
    cells.push({
      x: cellX,
      y: cellY,
      text: categories[c] ?? "",
      fontSize,
      color,
      anchor: "middle",
      ...textStyle
    });
  }
  // Series rows — series name (left-aligned, optionally preceded by a
  // swatch) + one value per category.
  for (let s = 0; s < normalized.length; s++) {
    const series = normalized[s];
    const rowY = rows[s + 1] + rowHeight / 2 + fontSize / 3;
    if (showKeys) {
      const swatchX = tableLeft + DATA_TABLE_CELL_PADDING_X;
      const swatchY = rows[s + 1] + (rowHeight - DATA_TABLE_SWATCH_SIZE) / 2;
      legendSwatches.push({
        x: swatchX,
        y: swatchY,
        width: DATA_TABLE_SWATCH_SIZE,
        height: DATA_TABLE_SWATCH_SIZE,
        color: series.color
      });
    }
    const nameX = tableLeft + DATA_TABLE_CELL_PADDING_X + swatchWidth;
    cells.push({
      x: nameX,
      y: rowY,
      text: series.label || "",
      fontSize,
      color,
      anchor: "start",
      ...textStyle
    });
    for (let c = 0; c < categories.length; c++) {
      const v = series.values[c];
      const cellX = columns[c + 1] + catWidth / 2;
      cells.push({
        x: cellX,
        y: rowY,
        text: formatDataTableValue(v),
        fontSize,
        color,
        anchor: "middle",
        ...textStyle
      });
    }
  }

  // Borders — Excel's three toggles map to three primitive strokes:
  // * showOutline      → outer rectangle
  // * showHorzBorder   → horizontal lines between rows
  // * showVertBorder   → vertical lines between columns
  // Any `spPr` on the dTable element is used for the stroke colour so
  // themed borders carry through from the source file.
  const borders: ChartSceneLine[] = [];
  const borderColor = getSpPrLineColor(table.spPr) ?? "#888888";
  const borderWidth = 0.75;
  const pushLine = (x1: number, y1: number, x2: number, y2: number): void => {
    borders.push({ x1, y1, x2, y2, color: borderColor, width: borderWidth });
  };
  if (table.showOutline !== false) {
    pushLine(rect.x, rect.y, rect.x + rect.width, rect.y);
    pushLine(rect.x, rect.y + rect.height, rect.x + rect.width, rect.y + rect.height);
    pushLine(rect.x, rect.y, rect.x, rect.y + rect.height);
    pushLine(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height);
  }
  if (table.showHorzBorder !== false) {
    for (let r = 1; r < rows.length - 1; r++) {
      pushLine(rect.x, rows[r], rect.x + rect.width, rows[r]);
    }
  }
  if (table.showVertBorder !== false) {
    // columns[0] and last are part of the outline.
    for (let c = 1; c < columns.length - 1; c++) {
      pushLine(columns[c], rect.y, columns[c], rect.y + rect.height);
    }
  }

  return { rect, columns, rows, cells, legendSwatches, borders };
}

function formatDataTableValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  // Match Excel's default "General" formatting: no trailing zeroes,
  // up to 6 significant digits.
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return Number.parseFloat(value.toPrecision(6)).toString();
}

/**
 * Unit-depth cabinet projection used by bar3D. `view3D.rotX` tilts the
 * view forward (positive → viewer sees the top of the column), and
 * `view3D.rotY` spins it to the right (positive → viewer sees the right
 * side). The two Excel defaults — `rotX=15`, `rotY=20`,
 * `rAngAx=true` (right-angle axes) — stay in sync with this projection
 * when `view3D` is absent. Returns unit deltas (dx/dy per pixel of
 * depth) so callers can scale by their own bar-width heuristic.
 *
 * `rAngAx` does not kill horizontal extrusion — Excel's right-angle
 * mode still projects the depth vector onto screen space via `rotY`,
 * because without that `dx` a bar3D would collapse into a flat 2D
 * bar. The flag only means "axes stay perpendicular in 3D world
 * space" (vs. pivoting into a trimetric projection).
 *
 * Horizontal extrusion depends on `sin(rotY)`, not `cos(rotY)`: at
 * `rotY=0` the viewer is looking straight at the bar, so the depth
 * vector points directly away from the camera and contributes zero
 * horizontal screen offset. At `rotY=90°` the viewer is looking from
 * the side, so the full depth projects onto the screen's x-axis.
 * The previous `cos(rotY)` was backwards: it gave maximum `dx=0.6`
 * at `rotY=0` and zero at `rotY=90°`. The default `rotY=20°` happened
 * to look plausible (`cos(20°)≈0.94`, so the bar still extruded), but
 * any custom rotation rendered with the wrong horizontal offset.
 */
function resolveBar3DProjection(view3D: ChartModel["chart"]["view3D"] | undefined): {
  dx: number;
  dy: number;
} {
  const rotX = toRad(view3D?.rotX ?? 15);
  const rotY = toRad(view3D?.rotY ?? 20);
  // `view3D.depthPercent` (OOXML `c:view3D/c:depthPercent/@val`,
  // schema default 100, valid range 20–2000) scales the depth-axis
  // extrusion magnitude. Previously this setting was silently ignored —
  // a bar3D chart with `<c:depthPercent val="400"/>` rendered
  // identically to the default. Clamp to the schema's stated range so
  // pathological values don't produce off-surface extrusions.
  const rawDepth = view3D?.depthPercent ?? 100;
  const depthFactor =
    Number.isFinite(rawDepth) && rawDepth > 0 ? Math.min(2000, Math.max(20, rawDepth)) / 100 : 1;
  return {
    dx: 0.6 * Math.sin(rotY) * depthFactor,
    dy: 0.6 * Math.sin(rotX) * depthFactor
  };
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function getSpPrLineColor(spPr: DataTable["spPr"]): string | undefined {
  if (!spPr) {
    return undefined;
  }
  // `getSpPrLine` handles both structured ShapeProperties and
  // `_rawXml` passthroughs; `resolveChartColor` accepts every
  // DrawingML colour variant (srgb / theme / sysClr / prstClr).
  // Previously this helper read `line.color.srgb` only, so a
  // theme-coloured data-table frame silently fell back to the
  // caller's default (grey).
  return resolveChartColor(getSpPrLine(spPr)?.color);
}

function buildSceneSeries(
  groups: ChartTypeGroup[],
  normalized: NormalizedSeries[],
  plot: ChartSceneRect,
  axisContext: ChartAxisContext,
  categories: string[],
  view3D?: ChartModel["chart"]["view3D"]
): ChartSceneSeries[] {
  const result: ChartSceneSeries[] = [];
  for (const group of groups) {
    const groupSeries = normalized.filter(s => s.group === group);
    if (groupSeries.length === 0) {
      continue;
    }
    if (group.type === "pie" || group.type === "pie3D" || group.type === "doughnut") {
      const first = groupSeries[0];
      const yRange = getSeriesYRange(first, axisContext);
      result.push(
        withAdornments(
          buildPieSeries(
            group.type === "doughnut" ? "doughnut" : "pie",
            first.values,
            plot,
            group.type === "doughnut",
            first,
            (group as { firstSliceAng?: number }).firstSliceAng,
            (group as { holeSize?: number }).holeSize
          ),
          first,
          plot,
          yRange.min,
          yRange.max,
          categories
        )
      );
      continue;
    }
    if (group.type === "ofPie") {
      const first = groupSeries[0];
      const yRange = getSeriesYRange(first, axisContext);
      result.push(
        withAdornments(
          buildOfPieSeries(first.values, plot, group.secondPieSize, first),
          first,
          plot,
          yRange.min,
          yRange.max,
          categories
        )
      );
      continue;
    }
    if (group.type === "radar") {
      for (const s of groupSeries) {
        const yRange = getSeriesYRange(s, axisContext);
        result.push(
          withAdornments(
            buildRadarSeries(s, plot, yRange.min, yRange.max, group.radarStyle === "filled"),
            s,
            plot,
            yRange.min,
            yRange.max,
            categories
          )
        );
      }
      continue;
    }
    if (group.type === "stock") {
      const yRange = getGroupYRange(group, axisContext);
      result.push(buildStockSeries(groupSeries, plot, yRange.min, yRange.max, categories));
      continue;
    }
    if (group.type === "surface" || group.type === "surface3D") {
      const yRange = getGroupYRange(group, axisContext);
      result.push(buildSurfaceSeries(groupSeries, plot, yRange.min, yRange.max, group.wireframe));
      continue;
    }
    if (group.type === "area" || group.type === "area3D") {
      const groupRange = getGroupYRange(group, axisContext);
      const baselineY = valueToY(
        axisBaseline(groupRange.min, groupRange.max),
        groupRange.min,
        groupRange.max,
        plot
      );
      const stacked = group.grouping === "stacked" || group.grouping === "percentStacked";
      const percent = group.grouping === "percentStacked";
      // Percent-stacked axis range is `[0, 1]` for all-positive data
      // and `[-1, 1]` when any series contains negative values — Excel
      // stacks positives upward and negatives downward from the zero
      // baseline, so the axis needs to span both sides. The old
      // unconditional `{0, 1}` clipped every negative segment below the
      // plot rectangle (label ladder said `-100%..100%` but bars were
      // drawn against `0..1`).
      const percentHasNegatives =
        percent && groupSeries.some(s => s.values.some(v => Number.isFinite(v) && v < 0));
      const percentRange: ValueRange = percentHasNegatives
        ? { min: -1, max: 1 }
        : { min: 0, max: 1 };
      for (const s of groupSeries) {
        const yRange = percent ? percentRange : getSeriesYRange(s, axisContext);
        const band = stacked
          ? buildStackedAreaBand(groupSeries, s.seriesIndex, plot, yRange.min, yRange.max, percent)
          : { upper: buildLinePoints(s.values, plot, yRange.min, yRange.max), lower: undefined };
        result.push(
          withAdornments(
            {
              type: "area",
              color: s.color,
              label: s.label,
              points: band.upper,
              lowerPoints: band.lower,
              baselineY,
              closed: group.type === "area3D"
            },
            s,
            plot,
            yRange.min,
            yRange.max,
            categories
          )
        );
      }
      continue;
    }
    if (group.type === "bubble") {
      const showNegBubbles = group.showNegBubbles === true;
      for (const s of groupSeries) {
        const yRange = getSeriesYRange(s, axisContext);
        const xRange = getSeriesXRange(s, axisContext);
        result.push(
          withAdornments(
            {
              type: "bubble",
              color: s.color,
              label: s.label,
              bubbles: buildBubbles(
                s,
                plot,
                yRange.min,
                yRange.max,
                xRange.min,
                xRange.max,
                showNegBubbles
              )
            },
            s,
            plot,
            yRange.min,
            yRange.max,
            categories,
            xRange
          )
        );
      }
      continue;
    }
    if (group.type === "line" || group.type === "line3D" || group.type === "scatter") {
      const sceneType = group.type === "scatter" ? "scatter" : "line";
      // Stacked / percent-stacked line charts render each series'
      // cumulative top — the same geometry the author would get in
      // Excel. Previously the renderer drew raw `s.values` regardless
      // of `grouping`, so a stacked line chart looked identical to a
      // clustered one. Scatter charts do not participate in stacking
      // (they're value/value, not category/value), so keep them on
      // the raw path.
      const isLineStacked =
        (group.type === "line" || group.type === "line3D") &&
        (group.grouping === "stacked" || group.grouping === "percentStacked");
      const isPercentStacked = isLineStacked && group.grouping === "percentStacked";
      const stackedTotalsCache = isLineStacked
        ? stackedTotals(groupSeries, maxSeriesLength(groupSeries), isPercentStacked)
        : undefined;
      // Percent-stacked line axis mirrors the bar / area treatment —
      // `[-1, 1]` when any series contains negatives so negative
      // segments render inside the plot; `[0, 1]` otherwise.
      const linePercentHasNegatives =
        isPercentStacked && groupSeries.some(s => s.values.some(v => Number.isFinite(v) && v < 0));
      const linePercentRange: ValueRange = linePercentHasNegatives
        ? { min: -1, max: 1 }
        : { min: 0, max: 1 };
      for (const s of groupSeries) {
        const yRange = isPercentStacked ? linePercentRange : getSeriesYRange(s, axisContext);
        const xRange = getSeriesXRange(s, axisContext);
        const points =
          group.type === "scatter"
            ? buildScatterPoints(s, plot, yRange.min, yRange.max, xRange.min, xRange.max)
            : isLineStacked && stackedTotalsCache
              ? buildLinePoints(
                  Array.from({ length: maxSeriesLength(groupSeries) }, (_, i) =>
                    stackedValueAt(groupSeries, s.seriesIndex, i, stackedTotalsCache, true)
                  ),
                  plot,
                  yRange.min,
                  yRange.max
                )
              : buildLinePoints(s.values, plot, yRange.min, yRange.max);
        result.push(
          withAdornments(
            {
              type: sceneType,
              color: s.color,
              label: s.label,
              points,
              // `smooth` controls whether the line is drawn with curve
              // interpolation (`c:smooth`). Previously the expression
              // conflated it with `s.marker?.symbol === "auto"` —
              // the auto-marker default triggered smoothing on every
              // marker-less line series, overriding an explicit
              // `group.smooth === false` and producing rounded lines
              // where the user asked for straight segments. Two
              // concepts; read `group.smooth` alone.
              smooth: "smooth" in group ? (group.smooth ?? false) : false,
              showLine: group.type !== "scatter" || group.scatterStyle !== "marker"
            },
            s,
            plot,
            yRange.min,
            yRange.max,
            categories,
            group.type === "scatter" ? xRange : undefined
          )
        );
      }
      continue;
    }
    if (group.type === "bar" || group.type === "bar3D") {
      const stacked = group.grouping === "stacked" || group.grouping === "percentStacked";
      const percent = group.grouping === "percentStacked";
      // Percent-stacked axis range is `[0, 1]` unless the data crosses
      // zero, in which case `[-1, 1]` so negative segments render inside
      // the plot rectangle. `stackedValueAt` returns signed fractions
      // (`accum / totals[i]`, and `accum` carries the sign of the side
      // the current series sits on), so a bar with value `-30` in a
      // `[+50, -30]` column yields `-0.3`. With `yRange={0,1}` that
      // pixelates to `plot.y + 1.3*plot.height` — 30% below the frame.
      const percentHasNegatives =
        percent && groupSeries.some(s => s.values.some(v => Number.isFinite(v) && v < 0));
      const percentRange: ValueRange = percentHasNegatives
        ? { min: -1, max: 1 }
        : { min: 0, max: 1 };
      // Cabinet-ish axonometric projection for bar3D. The OOXML default
      // view is rotX=15°, rotY=20°, depthPercent=100; when authors leave
      // `view3D` unset we fall back to those values so the preview still
      // reads as 3D. The scalar `0.35` shrinks the depth to ~one-third
      // the bar width so a column of typical bars doesn't dominate the
      // plot area — Excel itself biases the default projection this way.
      const proj = group.type === "bar3D" ? resolveBar3DProjection(view3D) : undefined;
      for (const s of groupSeries) {
        const horizontal = group.barDir === "bar";
        const yRange = percent ? percentRange : getSeriesYRange(s, axisContext);
        const bars = stacked
          ? buildStackedBars(
              groupSeries,
              s.seriesIndex,
              horizontal,
              plot,
              yRange.min,
              yRange.max,
              percent
            )
          : horizontal
            ? buildHorizontalBars(
                s.values,
                s.seriesIndex,
                groupSeries.length,
                categories,
                plot,
                yRange.min,
                yRange.max
              )
            : buildBars(
                s.values,
                s.seriesIndex,
                groupSeries.length,
                categories,
                plot,
                yRange.min,
                yRange.max
              );
        // Scale bar3D depth to roughly 30% of the narrowest bar width
        // (or 20% of the plot width for stacked bars) so the 3D effect
        // is visible but doesn't crush the series. A hard floor of 6px
        // keeps tiny bars from losing their depth cue entirely.
        const bar3DDepth = proj
          ? Math.max(
              6,
              Math.min(
                bars.reduce(
                  (m, r) => Math.min(m, horizontal ? r.height : r.width),
                  Number.POSITIVE_INFINITY
                ) * 0.3,
                plot.width * 0.12
              )
            )
          : 0;
        result.push(
          withAdornments(
            {
              type: "bar",
              color: s.color,
              label: s.label,
              horizontal,
              depth: group.type === "bar3D" ? bar3DDepth : 0,
              projection3D: proj
                ? {
                    dx: proj.dx * bar3DDepth,
                    dy: proj.dy * bar3DDepth
                  }
                : undefined,
              bars
            },
            s,
            plot,
            yRange.min,
            yRange.max,
            categories
          )
        );
      }
    }
  }
  return result;
}

function buildBars(
  values: number[],
  seriesIndex: number,
  seriesCount: number,
  categories: string[],
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartSceneRect[] {
  const count = Math.max(1, categories.length, values.length);
  const groupWidth = plot.width / count;
  const barWidth = (groupWidth * 0.72) / Math.max(1, seriesCount);
  // Anchor bars at the axis baseline, not at the virtual value `0`.
  // When the axis range excludes zero (e.g. user-authored `min: 20`)
  // the previous `valueToY(0, …)` coordinate sat below the plot area
  // and bars rendered overflowing the plot frame. Clamp `0` into
  // `[min, max]` so bars grow from the axis floor upward, matching
  // Excel's native behaviour.
  const zero = valueToY(axisBaseline(min, max), min, max, plot);
  return values.map((value, i) => {
    // Skip NaN/non-finite values — produce a zero-height bar that is
    // invisible rather than injecting NaN coordinates into SVG/PDF.
    if (!Number.isFinite(value)) {
      return {
        x: plot.x + i * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth,
        y: zero,
        width: barWidth,
        height: 0
      };
    }
    const y = valueToY(value, min, max, plot);
    return {
      x: plot.x + i * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth,
      y: Math.min(y, zero),
      width: barWidth,
      height: Math.abs(zero - y)
    };
  });
}

/**
 * Effective axis baseline — the coordinate bars anchor to and stacked
 * segments chain from. Defaults to `0` for ranges that straddle zero;
 * when the axis explicitly excludes zero (e.g. `min: 20, max: 100`),
 * clamp to the nearer end so bars grow from the visible axis floor
 * rather than from a virtual zero that lives outside the plot area.
 * Handles reversed axes (`min > max`, from `scaling.orientation =
 * "maxMin"`) too.
 */
function axisBaseline(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo <= 0 && hi >= 0) {
    return 0;
  }
  // Range entirely above zero — baseline at the lower bound (axis floor).
  if (lo > 0) {
    return lo;
  }
  // Range entirely below zero — baseline at the upper bound (axis ceiling).
  return hi;
}

function buildHorizontalBars(
  values: number[],
  seriesIndex: number,
  seriesCount: number,
  categories: string[],
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartSceneRect[] {
  const count = Math.max(1, categories.length, values.length);
  const groupHeight = plot.height / count;
  const barHeight = (groupHeight * 0.72) / Math.max(1, seriesCount);
  // Anchor bars at the axis baseline (see `axisBaseline` for the
  // clamp rule). A value-axis range that excludes zero previously
  // forced bars to anchor at the virtual `0` coordinate which fell
  // outside the plot area, making bars overflow the chart frame.
  const zero = valueToX(axisBaseline(min, max), min, max, plot);
  return values.map((value, i) => {
    // Skip NaN/non-finite values — produce a zero-width bar that is
    // invisible rather than injecting NaN coordinates into SVG/PDF.
    if (!Number.isFinite(value)) {
      return {
        x: zero,
        y: plot.y + i * groupHeight + groupHeight * 0.14 + seriesIndex * barHeight,
        width: 0,
        height: barHeight
      };
    }
    const x = valueToX(value, min, max, plot);
    return {
      x: Math.min(x, zero),
      y: plot.y + i * groupHeight + groupHeight * 0.14 + seriesIndex * barHeight,
      width: Math.abs(x - zero),
      height: barHeight
    };
  });
}

function buildStackedBars(
  groupSeries: NormalizedSeries[],
  seriesIndex: number,
  horizontal: boolean,
  plot: ChartSceneRect,
  min: number,
  max: number,
  percent: boolean
): ChartSceneRect[] {
  const count = maxSeriesLength(groupSeries);
  const slot = horizontal ? plot.height / count : plot.width / count;
  const thickness = slot * 0.72;
  const totals = stackedTotals(groupSeries, count, percent);
  return Array.from({ length: count }, (_, i) => {
    const start = stackedValueAt(groupSeries, seriesIndex, i, totals, false);
    const end = stackedValueAt(groupSeries, seriesIndex, i, totals, true);
    if (horizontal) {
      const x1 = valueToX(start, min, max, plot);
      const x2 = valueToX(end, min, max, plot);
      // Each stack segment spans exactly `[start, end]`. The bar's left
      // edge is `Math.min(x1, x2)` — i.e. x1 for a positive segment, x2
      // for a negative one. A previous version included `zeroX` in the
      // min, which only happened to work for segments that straddle
      // zero or start at zero (the first segment of each stack). Any
      // later positive segment rendered anchored at `zeroX` instead of
      // `x1`, collapsing every stack past the first series into the
      // axis origin with a width equal to only its own delta.
      return {
        x: Math.min(x1, x2),
        y: plot.y + i * slot + slot * 0.14,
        width: Math.abs(x2 - x1),
        height: thickness
      };
    }
    const y1 = valueToY(start, min, max, plot);
    const y2 = valueToY(end, min, max, plot);
    // Vertical axis: SVG y grows downward, so `Math.min(y1, y2)` picks
    // the topmost pixel — that's the larger value for a positive
    // segment, the smaller-absolute value for a negative segment. The
    // previous `Math.min(y1, y2, zeroY)` broke stacks of negative
    // segments that didn't reach zero: a negative stack past the first
    // series was anchored at the zero-line instead of at the top of
    // its own slice, sliding the rectangle up towards the axis.
    return {
      x: plot.x + i * slot + slot * 0.14,
      y: Math.min(y1, y2),
      width: thickness,
      height: Math.abs(y2 - y1)
    };
  });
}

function buildStackedAreaBand(
  groupSeries: NormalizedSeries[],
  seriesIndex: number,
  plot: ChartSceneRect,
  min: number,
  max: number,
  percent: boolean
): { upper: ChartScenePoint[]; lower: ChartScenePoint[] } {
  const count = maxSeriesLength(groupSeries);
  const totals = stackedTotals(groupSeries, count, percent);
  const lowerValues = Array.from({ length: count }, (_, i) =>
    stackedValueAt(groupSeries, seriesIndex, i, totals, false)
  );
  const upperValues = Array.from({ length: count }, (_, i) =>
    stackedValueAt(groupSeries, seriesIndex, i, totals, true)
  );
  return {
    lower: buildLinePoints(lowerValues, plot, min, max),
    upper: buildLinePoints(upperValues, plot, min, max)
  };
}

function stackedTotals(groupSeries: NormalizedSeries[], count: number, percent: boolean): number[] {
  // Excel splits stacked totals by sign: positives stack upward from
  // zero, negatives stack downward. For **percent-stacked** the
  // denominator is `|positive_sum| + |negative_sum|` so each bar still
  // fills the axis width, but negatives extend left/down. The previous
  // implementation clamped with `Math.max(0, v)` — which silently
  // dropped every negative value and produced totals that were too
  // small for charts containing any negatives.
  return Array.from({ length: count }, (_, i) => {
    if (!percent) {
      return 1;
    }
    let absSum = 0;
    for (const s of groupSeries) {
      const v = s.values[i];
      if (typeof v === "number" && Number.isFinite(v)) {
        absSum += Math.abs(v);
      }
    }
    return absSum || 1;
  });
}

function stackedValueAt(
  groupSeries: NormalizedSeries[],
  seriesIndex: number,
  pointIndex: number,
  totals: number[],
  includeCurrent: boolean
): number {
  // Split positive and negative contributions — they stack along
  // opposite directions from the zero baseline. For the `end` of the
  // current slice we include the current series' contribution in the
  // side matching its sign; for the `start` we take only the earlier
  // series' contributions on that same side (so the rectangle covers
  // exactly this series' delta).
  const currentValue = groupSeries[seriesIndex]?.values[pointIndex];
  const currentIsFinite = typeof currentValue === "number" && Number.isFinite(currentValue);
  const currentSide: 1 | -1 = currentIsFinite && (currentValue as number) < 0 ? -1 : 1;
  let accum = 0;
  const upto = includeCurrent ? seriesIndex : seriesIndex - 1;
  for (let i = 0; i <= upto; i++) {
    const v = groupSeries[i]?.values[pointIndex];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      continue;
    }
    const side: 1 | -1 = v < 0 ? -1 : 1;
    if (side !== currentSide) {
      continue;
    }
    accum += v;
  }
  return accum / totals[pointIndex];
}

function buildScatterPoints(
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number,
  xMin?: number,
  xMax?: number
): ChartScenePoint[] {
  const xValues =
    series.xValues && series.xValues.length > 0
      ? series.xValues
      : series.values.map((_, i) => i + 1);
  // Fold via a loop rather than `Math.min(0, ...xValues.filter(...))`
  // / `Math.max(1, ...)`; the spread form blows the call stack past
  // ~100k entries (large time-series scatters).
  //
  // Seed ±Infinity so the range converges on the actual x extremes.
  // The old `min=0, max=1` seeds anchored the range incorrectly when
  // every value was above 1 (`[10,20,30]` → `{0, 30}`) or below 0
  // (`[-30,-20,-10]` → `{-30, 1}`), which mis-positioned scatter points
  // to the left/right of where the axis labels implied.
  let computedXMin = Infinity;
  let computedXMax = -Infinity;
  for (const x of xValues) {
    if (!Number.isFinite(x)) {
      continue;
    }
    if (x < computedXMin) {
      computedXMin = x;
    }
    if (x > computedXMax) {
      computedXMax = x;
    }
  }
  if (!Number.isFinite(computedXMin) || !Number.isFinite(computedXMax)) {
    computedXMin = 0;
    computedXMax = Math.max(1, xValues.length);
  }
  const effectiveXMin = xMin ?? computedXMin;
  const effectiveXMax = xMax ?? computedXMax;
  return series.values.map((value, i) => ({
    x: valueToX(
      xValues[i] ?? i + 1,
      effectiveXMin,
      effectiveXMax <= effectiveXMin ? effectiveXMin + 1 : effectiveXMax,
      plot
    ),
    y: valueToY(value, min, max, plot)
  }));
}

function buildLinePoints(
  values: number[],
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartScenePoint[] {
  const step = values.length > 1 ? plot.width / (values.length - 1) : plot.width;
  return values.map((value, i) => ({ x: plot.x + i * step, y: valueToY(value, min, max, plot) }));
}

function buildBubbles(
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number,
  xMin?: number,
  xMax?: number,
  showNegBubbles = false
): ChartSceneBubble[] {
  const xValues =
    series.xValues && series.xValues.length > 0
      ? series.xValues
      : series.values.map((_, i) => i + 1);
  const yValues = series.values;
  const sizes = series.bubbleSizes ?? [];
  // Fold with `reduce` rather than `Math.max(...arr)` / `Math.min(...arr)`
  // — the spread form blows the JS call stack once the array grows past
  // ~100k entries (large scatter / bubble time-series).
  //
  // Seed `sizeMax` at `0`, not `1`. When every authored size is < 1
  // (e.g. all sizes = `0.5`), the old `sizeMax=1` seed never got
  // overwritten, so `radius = 4 + sqrt(size)/sqrt(1) * 16 ≈ 15.3` for
  // every bubble — the relative visual scaling (biggest bubble vs.
  // smallest bubble) collapsed. Initialising at `0` lets the fold pick
  // the true max; guard against div-by-zero at the call site.
  let sizeMax = 0;
  for (const s of sizes) {
    // When `showNegBubbles=false` (OOXML default) the render loop below
    // skips negative-sized bubbles entirely — so they must not
    // contribute to `sizeMax` either. Previously the fold used
    // `Math.abs(s)`, which let an invisible `size=-100` inflate the
    // denominator and visually shrink every rendered positive bubble
    // (e.g. sizes `[10, -100, 20]` gave every visible bubble the
    // radius it would have had if the -100 were a real 100-unit
    // bubble). Gate on sign when negatives are hidden; fall back to
    // `|s|` when `showNegBubbles=true` so the absolute-magnitude
    // rendering stays consistent with the per-point radius computation.
    const contributes = showNegBubbles ? Math.abs(s) : s;
    if (Number.isFinite(contributes) && contributes > sizeMax) {
      sizeMax = contributes;
    }
  }
  // Seed ±Infinity so `xValues=[10,20,30]` produces {10, 30} instead of
  // `{0, 30}` (the old `min=0, max=1` seeds incorrectly anchored the
  // x-domain at `0` whenever the data didn't cross it).
  let computedXMin = Infinity;
  let computedXMax = -Infinity;
  for (const x of xValues) {
    if (!Number.isFinite(x)) {
      continue;
    }
    if (x < computedXMin) {
      computedXMin = x;
    }
    if (x > computedXMax) {
      computedXMax = x;
    }
  }
  if (!Number.isFinite(computedXMin) || !Number.isFinite(computedXMax)) {
    computedXMin = 0;
    computedXMax = Math.max(1, xValues.length);
  }
  const effectiveXMin = xMin ?? computedXMin;
  const effectiveXMax = xMax ?? computedXMax;
  const count = Math.max(xValues.length, yValues.length);
  const out: ChartSceneBubble[] = [];
  for (let i = 0; i < count; i++) {
    const rawSize = sizes[i];
    // `showNegBubbles=false` (OOXML default) hides bubbles with
    // negative size — a true "data-driven omission" rather than an
    // absolute-value rescale. `showNegBubbles=true` renders them using
    // the absolute magnitude so the author's requested visual appears;
    // previously the renderer always dropped negative bubbles, giving
    // authors no way to opt in to Excel's native "show negatives"
    // behaviour.
    if (!showNegBubbles && typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize < 0) {
      continue;
    }
    // Skip points with non-finite x or y — `??` only catches null /
    // undefined, so `NaN ?? 0` stays `NaN` and propagates to
    // `valueToY`, emitting a ghost bubble at `(0,0)` in the SVG (since
    // `fmt(NaN)` returns `"0"`). `collectNumberValues` maps blank /
    // error cells to `NaN`, which is a common case for bubble data.
    const xRaw = xValues[i] ?? i + 1;
    const yRaw = yValues[i] ?? 0;
    if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
      continue;
    }
    const rawSafeSize = typeof rawSize === "number" && Number.isFinite(rawSize) ? rawSize : 1;
    const safeSize = Math.abs(rawSafeSize);
    // `sizeMax === 0` happens for bubble series with no authored sizes
    // (empty array) or all-zero sizes — every bubble collapses to a
    // point. Fall back to `1` so the sqrt denominator stays non-zero
    // and every bubble renders at the minimum radius.
    const sizeDenom = sizeMax > 0 ? Math.sqrt(sizeMax) : 1;
    out.push({
      x: valueToX(
        xRaw,
        effectiveXMin,
        effectiveXMax <= effectiveXMin ? effectiveXMin + 1 : effectiveXMax,
        plot
      ),
      y: valueToY(yRaw, min, max, plot),
      radius: 4 + (Math.sqrt(safeSize) / sizeDenom) * 16
    });
  }
  return out;
}

function buildPieSeries(
  type: "pie" | "doughnut",
  values: number[],
  plot: ChartSceneRect,
  doughnut: boolean,
  series?: NormalizedSeries,
  firstSliceAng?: number,
  holeSize?: number
): ChartScenePieSeries {
  const radius = Math.min(plot.width, plot.height) / 2.35;
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  // Excel renders pie slices using the absolute magnitude of each
  // value, so negative values still produce a visible wedge (flipped
  // to its positive magnitude). Using `Math.max(0, v)` here collapsed
  // negative slices to zero-width wedges and, worse, disagreed with
  // `buildDataLabels` which already uses `Math.abs(v)` for the
  // percentage total. Mirror the label convention so slices and
  // labels stay in lock-step.
  //
  // Non-finite values (blank / `#N/A` cells — `collectNumberValues`
  // deliberately maps those to `NaN` to preserve slot identity) must
  // be skipped: `Math.abs(NaN) = NaN`, which poisons `total` and then
  // every downstream `angle = next = angle + NaN/1 = NaN`, collapsing
  // every subsequent slice to the SVG origin. Coerce to zero-sweep so
  // the gap is simply absent from the pie.
  const total = values.reduce((sum, v) => sum + (Number.isFinite(v) ? Math.abs(v) : 0), 0) || 1;
  // Per-slice colour overrides from `series.dataPoints[idx].spPr.fill`.
  // Pie / doughnut charts in Excel almost always use data-point styling
  // (one colour per slice); previously the renderer ignored
  // `dataPoints` entirely and every slice rotated through the 6-entry
  // default palette — breaking the common "colour-by-category" idiom.
  const dataPointColors = collectDataPointColors(series);
  const dataPointExplosions = collectDataPointExplosions(series);
  // OOXML `firstSliceAng` is the clockwise offset (in degrees) from
  // 12 o'clock. Convert to radians and add to the SVG base angle
  // (`-π/2` = 12 o'clock). A missing / zero value keeps the classic
  // 12-o'clock start; positive values rotate the pie clockwise.
  const startAngle =
    -Math.PI / 2 +
    (firstSliceAng && Number.isFinite(firstSliceAng) ? (firstSliceAng * Math.PI) / 180 : 0);
  let angle = startAngle;
  const slices = values.map((value, i) => {
    const sweep = Number.isFinite(value) ? (Math.abs(value) / total) * Math.PI * 2 : 0;
    const next = angle + sweep;
    // Honour per-slice `explosion` (0–400 % of radius — Excel's native
    // range). Offset the centre along the angle bisector so the slice
    // visibly separates from the pie without changing its sweep.
    const explosion = dataPointExplosions[i] ?? 0;
    const offsetRadius = explosion > 0 ? radius * (explosion / 100) : 0;
    const mid = (angle + next) / 2;
    const slice = {
      color: dataPointColors[i] ?? COLORS[i % COLORS.length],
      cx: cx + Math.cos(mid) * offsetRadius,
      cy: cy + Math.sin(mid) * offsetRadius,
      radius,
      innerRadius: doughnut ? radius * resolveDoughnutHoleRatio(holeSize) : 0,
      startAngle: angle,
      endAngle: next
    };
    angle = next;
    return slice;
  });
  return { type, slices, label: series?.label };
}

function buildOfPieSeries(
  values: number[],
  plot: ChartSceneRect,
  secondPieSize = 75,
  series?: NormalizedSeries
): ChartScenePieSeries {
  const split = Math.max(1, Math.floor(values.length * 0.7));
  const primaryValues = values.slice(0, split);
  const secondaryValues = values.slice(split);
  const primary = buildPieSeries(
    "pie",
    primaryValues,
    { ...plot, width: plot.width * 0.62 },
    false,
    series
  );
  const radius =
    (Math.min(plot.width, plot.height) / 2.35) * Math.max(0.25, Math.min(2, secondPieSize / 100));
  const cx = plot.x + plot.width * 0.78;
  const cy = plot.y + plot.height / 2;
  let angle = -Math.PI / 2;
  // Use `|v|` for both the total and the slice sweep so mixed-sign
  // data produces a consistent geometry (matches `buildPieSeries` and
  // the `buildDataLabels` percentage formula). Skip non-finite values
  // (NaN from blank / `#N/A` source cells) — see `buildPieSeries` for
  // the rationale.
  const total =
    secondaryValues.reduce((sum, v) => sum + (Number.isFinite(v) ? Math.abs(v) : 0), 0) || 1;
  // Per-slice colour overrides for the secondary pie. Index is the
  // absolute source position (`split + i`), matching how Excel writes
  // `c:dPt` for ofPie series.
  const dataPointColors = collectDataPointColors(series);
  const secondarySlices = secondaryValues.map((value, i) => {
    const sweep = Number.isFinite(value) ? (Math.abs(value) / total) * Math.PI * 2 : 0;
    const next = angle + sweep;
    const slice = {
      color: dataPointColors[split + i] ?? COLORS[(split + i) % COLORS.length],
      cx,
      cy,
      radius,
      innerRadius: 0,
      startAngle: angle,
      endAngle: next
    };
    angle = next;
    return slice;
  });
  const connectors: ChartSceneLine[] = [
    {
      x1: primary.slices[0]?.cx ?? plot.x,
      y1: cy - radius,
      x2: cx - radius,
      y2: cy - radius,
      color: GRID_COLOR
    },
    {
      x1: primary.slices[0]?.cx ?? plot.x,
      y1: cy + radius,
      x2: cx - radius,
      y2: cy + radius,
      color: GRID_COLOR
    }
  ];
  return { type: "ofPie", slices: primary.slices, secondarySlices, connectors };
}

function buildRadarSeries(
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number,
  filled: boolean
): ChartSceneRadarSeries {
  const center = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
  const radius = Math.min(plot.width, plot.height) / 2.25;
  // Guard against `max === min` (all values equal, e.g. `[3, 3, 3, 3]`).
  // `(value - min) / (max - min)` would yield `NaN` which `fmt` silently
  // collapses to "0", producing a radar with every vertex at the
  // centre. Widen the range so each vertex sits at the outer ring.
  const span = max - min;
  const safeSpan = span === 0 || !Number.isFinite(span) ? 1 : span;
  // Distribute each point evenly around the circle using the *actual*
  // series length as the divisor. The old `Math.max(3, length)` clamp
  // was meant to guarantee a valid polygon, but for a 2-point radar it
  // produced vertices at `0°` and `120°` instead of the symmetric
  // `0°` and `180°`, leaving a blank 240° wedge. For `length < 3` the
  // resulting "polygon" is a line segment / single point; that's
  // expected — radar charts with 1-2 categories have no well-defined
  // polygon fill anyway, and `Math.max(1, …)` guards against
  // `NaN` / division by zero.
  const divisor = Math.max(1, series.values.length);
  const points = series.values.map((value, i) => {
    const angle = -Math.PI / 2 + (i / divisor) * Math.PI * 2;
    // Non-finite values (blank / `#N/A` cells — `collectNumberValues`
    // emits NaN to preserve slot identity) must NOT be projected to
    // the plot centre. Previously we coerced `normalised = 0`, which
    // placed the vertex at the origin and left the polygon with a
    // sharp "V" cut from the previous vertex through the centre and
    // back out to the next — nothing like Excel's actual gap handling.
    // Emit `{NaN, NaN}` so the renderer's `segmentFinitePoints` pass
    // can split the polygon at the gap (matching line / area behaviour).
    if (!Number.isFinite(value)) {
      return { x: Number.NaN, y: Number.NaN };
    }
    const normalised = (value - min) / safeSpan;
    const r = normalised * radius;
    return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
  });
  return {
    type: "radar",
    color: series.color,
    points,
    center,
    radius,
    filled,
    label: series.label
  };
}

function buildStockSeries(
  groupSeries: NormalizedSeries[],
  plot: ChartSceneRect,
  min: number,
  max: number,
  categories: string[]
): ChartSceneStockSeries {
  const count = Math.max(1, categories.length, ...groupSeries.map(s => s.values.length));
  const groupWidth = plot.width / count;
  const candleWidth = Math.max(3, groupWidth * 0.45);
  // Return `undefined` for non-finite (gap) values — NaN from
  // `collectNumberValues` would otherwise propagate through `Math.max` /
  // `Math.min` below and poison every `valueToY` output, rendering the
  // candle as a zero-height bar at the plot top.
  const firstValue = (seriesIndex: number, pointIndex: number): number | undefined => {
    const raw = groupSeries[seriesIndex]?.values[pointIndex];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  };
  const useVolume = groupSeries.length >= 5;
  const offset = useVolume ? 1 : 0;
  const hasOpen = groupSeries.length - offset >= 4;
  const candles: ChartSceneStockCandle[] = [];
  for (let i = 0; i < count; i++) {
    // Read each OHLC channel directly from its source series. The
    // previous `??` fallback chain (e.g. `high ?? open`, `close ?? low`)
    // silently fabricated values for gap slots — a HL-only chart with
    // `high=10, low=undefined` would emit a phantom candle with
    // `low=high=10`, and an OHLC chart with a missing close would
    // emit `close=low`, flattening the candle body to the wick bottom.
    // Treat each missing channel as a genuine gap and feed `defined`
    // only the values that are actually present, so the wick / body
    // reflect authored data rather than synthesised fallbacks.
    const open = hasOpen ? firstValue(offset, i) : undefined;
    const high = firstValue(offset + (hasOpen ? 1 : 0), i);
    const low = firstValue(offset + (hasOpen ? 2 : 1), i);
    const close = firstValue(offset + (hasOpen ? 3 : 2), i);
    // Gather the defined extremes so `Math.max` / `Math.min` never see
    // `NaN`. Skip the candle entirely when no finite data point is
    // present — the scene builder will emit nothing for that slot and
    // the PNG / PDF surfaces won't draw phantom lines at the plot top.
    const defined: number[] = [];
    if (typeof open === "number") {
      defined.push(open);
    }
    if (typeof high === "number") {
      defined.push(high);
    }
    if (typeof low === "number") {
      defined.push(low);
    }
    if (typeof close === "number") {
      defined.push(close);
    }
    if (defined.length === 0) {
      continue;
    }
    const hi = defined.reduce((a, b) => (b > a ? b : a), defined[0]);
    const lo = defined.reduce((a, b) => (b < a ? b : a), defined[0]);
    candles.push({
      x: plot.x + i * groupWidth + groupWidth / 2,
      highY: valueToY(hi, min, max, plot),
      lowY: valueToY(lo, min, max, plot),
      openY: open === undefined ? undefined : valueToY(open, min, max, plot),
      closeY: close === undefined ? undefined : valueToY(close, min, max, plot),
      width: candleWidth,
      // When either endpoint of the body is missing the up/down state
      // is undefined by the data — leave `up` as `true` (Excel's own
      // default for partial candles) but note that callers should skip
      // drawing the body on `open === undefined || close === undefined`
      // so the colour never matters.
      up: open === undefined || close === undefined ? true : close >= open
    });
  }
  return { type: "stock", color: COLORS[0], candles, label: groupSeries[0]?.label };
}

function buildSurfaceSeries(
  groupSeries: NormalizedSeries[],
  plot: ChartSceneRect,
  min: number,
  max: number,
  wireframe?: boolean
): ChartSceneSurfaceSeries {
  const rows = Math.max(1, groupSeries.length);
  const cols = maxSeriesLength(groupSeries);
  const cellWidth = plot.width / cols;
  const cellHeight = plot.height / rows;
  const cells: ChartSceneSurfaceCell[] = [];
  for (let r = 0; r < rows; r++) {
    const values = groupSeries[r]?.values ?? [];
    for (let c = 0; c < cols; c++) {
      const value = values[c] ?? min;
      const t = max <= min ? 0 : (value - min) / (max - min);
      cells.push({
        x: plot.x + c * cellWidth,
        y: plot.y + r * cellHeight,
        width: cellWidth,
        height: cellHeight,
        color: interpolateColor("#5B9BD5", "#ED7D31", Math.max(0, Math.min(1, t)))
      });
    }
  }
  return { type: "surface", cells, wireframe, label: groupSeries[0]?.label };
}

/**
 * Compute the set of value-axis tick positions for a given data range.
 *
 * Priority:
 *   1. If `axis.majorUnit` is set (author-specified tick step): generate
 *      ticks at `min`, `min + majorUnit`, `min + 2*majorUnit`, … up to
 *      (and including) `max`. Excel snaps ticks to `majorUnit` starting
 *      from the axis minimum, NOT from zero — matching
 *      `ST_AxisScaling/@majorUnit` semantics.
 *   2. Otherwise fall back to 6 evenly-spaced positions (`min, min + 1/5
 *      (max-min), …, max`). This matches Excel's behaviour when the
 *      author has not specified tick properties and the data range is
 *      within the auto-scaling band.
 *
 * The result is **always non-empty** so callers never have to guard
 * against an empty tick list. A degenerate `min === max` range collapses
 * to a single tick at that value.
 *
 * Honouring `majorUnit` is critical for two things:
 *   - gridlines align with the axis tick labels (previously gridlines
 *     were locked at 1/5 intervals regardless of the author's tick
 *     step, so any custom `majorUnit` produced gridlines and labels at
 *     different positions);
 *   - tick labels themselves render at the intended numeric grid
 *     (previously all value axes showed 6 evenly-spaced labels even
 *     when the author configured `majorUnit=10` on a `[0, 100]` range).
 */
function valueAxisTickPositions(min: number, max: number, axis: ChartAxis | undefined): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min];
  }
  // `majorUnit` lives on `ValueAxis` / `DateAxis` but not on the
  // category / series axis variants. Category / series axes never
  // reach this helper in practice — they have their own label
  // builders in `buildXLabels` / `buildYLabels` that key off the
  // category list. Narrow through `unknown` so the call site can
  // pass any `ChartAxis` without discriminating, and the missing
  // property simply resolves to `undefined`.
  const step = (axis as { majorUnit?: number } | undefined)?.majorUnit;
  if (typeof step === "number" && Number.isFinite(step) && step > 0) {
    // `min > max` when `scaling.orientation === "maxMin"` — `getValueRange`
    // swaps the endpoints so callers can flip the axis without knowing
    // about orientation. Walk ticks in the direction `min → max`; the
    // old `max - min` / `Math.floor(span/step)` produced a negative /
    // zero count for reversed axes, so only the final `ticks.push(max)`
    // fired and the axis ended up with a single tick label.
    const span = Math.abs(max - min);
    const direction = max >= min ? 1 : -1;
    // Cap at ~200 ticks for malformed inputs (tiny majorUnit on wide
    // range). Preview renderers should not allocate megabytes of tick
    // text to honour a typo; the cap is well above any legitimate
    // Excel value.
    const MAX_TICKS = 200;
    const rawCount = Math.floor(span / step) + 1;
    const count = Math.min(MAX_TICKS, rawCount);
    const ticks: number[] = [];
    for (let i = 0; i < count; i++) {
      ticks.push(min + direction * i * step);
    }
    // Always include the maximum so the gridline at the plot's top /
    // right edge is drawn even when `(max - min) % step !== 0`. When
    // the cap was hit, we still want `max` in the list — previously
    // the `count < MAX_TICKS` guard suppressed the trailing push in
    // that case, silently dropping the top-edge gridline and label.
    // Replace the nearest overshooting tick with `max` so the array
    // stays at its MAX_TICKS ceiling while still anchoring the upper
    // bound.
    const last = ticks[ticks.length - 1];
    if (last !== max) {
      if (count < MAX_TICKS) {
        ticks.push(max);
      } else {
        // Already at the cap — swap the last sample for `max` so the
        // array ends at the axis boundary and the preview's top/right
        // rail still carries a gridline.
        ticks[ticks.length - 1] = max;
      }
    }
    return ticks;
  }
  // Log-scale axis: place a tick at every integer power of the log
  // base inside the range. `min` / `max` are already in log space
  // (normalizeSeries pre-transforms values), so stepping by `1` gives
  // powers-of-base ticks (e.g. `[0, 1, 2, 3]` on a log10 axis over
  // `[10^0, 10^3]` → tick labels "1", "10", "100", "1000"). Ranges
  // spanning more than 6 decades fall back to the non-log uniform
  // path so labels don't crowd the axis.
  //
  // `getValueRange` returns `min > max` on reversed axes
  // (`scaling.orientation === "maxMin"`). The integer-power sweep must
  // walk the numeric interval — normalise to lo/hi first, then emit
  // ticks in the axis's display direction so downstream callers
  // position gridlines and labels consistently with the data.
  const logBase = axisScaleLogBase(axis);
  if (logBase !== undefined) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (hi - lo <= 6 + 1e-9) {
      const first = Math.ceil(lo - 1e-9);
      const last = Math.floor(hi + 1e-9);
      const span = last - first + 1;
      if (span >= 2 && span <= 20) {
        const ticks: number[] = [];
        const reversed = min > max;
        if (reversed) {
          for (let k = last; k >= first; k--) {
            ticks.push(k);
          }
        } else {
          for (let k = first; k <= last; k++) {
            ticks.push(k);
          }
        }
        return ticks;
      }
    }
  }
  // Fallback: generate ticks at "nice" round intervals (multiples of
  // 1, 2, 5 × 10^n) targeting ~10 ticks. This matches Excel's auto-
  // generated axis labels (e.g. 0, 20000, 40000, ...).
  // Handle reversed axes (`min > max` from `scaling.orientation =
  // "maxMin"`) by normalising to ascending order for tick generation,
  // then reversing the result so ticks render in descending order.
  const reversed = min > max;
  const lo = reversed ? max : min;
  const hi = reversed ? min : max;
  const span = hi - lo;
  if (span <= 0) {
    // Degenerate range — return a single tick at the midpoint.
    return [lo];
  }
  const rawStep = span / 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let niceStep: number;
  if (residual <= 1.5) {
    niceStep = magnitude;
  } else if (residual <= 3.5) {
    niceStep = 2 * magnitude;
  } else if (residual <= 7.5) {
    niceStep = 5 * magnitude;
  } else {
    niceStep = 10 * magnitude;
  }
  const ticks: number[] = [];
  const start = Math.ceil(lo / niceStep) * niceStep;
  for (let v = start; v <= hi + niceStep * 0.001; v += niceStep) {
    ticks.push(Math.round(v * 1e10) / 1e10); // avoid floating point noise
    if (ticks.length > 50) {
      break;
    }
  }
  // Ensure 0 is included when the range spans zero
  if (lo <= 0 && hi >= 0 && !ticks.includes(0)) {
    ticks.push(0);
    ticks.sort((a, b) => a - b);
  }
  if (reversed) {
    ticks.reverse();
  }
  return ticks;
}

/**
 * Read the logarithmic base configured on a value axis, if any.
 * Returns `undefined` for linear axes or when the base is out of
 * range (OOXML requires `logBase` strictly greater than 1 in the
 * range [2, 1000]; Excel's UI enforces [2, 1000] but we accept any
 * value `> 1` to stay lenient with third-party authors).
 */
/**
 * Read the log base configured on an axis's `scaling`. Returns
 * `undefined` when the axis is absent, linear, or carries an invalid
 * base (≤ 1 — OOXML requires `logBase` strictly greater than 1 in the
 * range [2, 1000]; we accept any value `> 1` to stay lenient with
 * third-party authors).
 *
 * Single source of truth — callers previously split between a pair of
 * near-identical helpers (`axisScaleLogBase` / `axisLogBase`) whose
 * validity gates disagreed (one rejected `base ≤ 1`, the other
 * rejected `base ≤ 0 || base === 1`). The disagreement meant that a
 * pathological base like `0.5` would be passed through by
 * `axisLogBase` (used for data-space transforms) but rejected by
 * `axisScaleLogBase` (used for tick positions), producing data points
 * that no longer landed on the tick marks.
 */
function axisLogBase(axis: ChartAxis | undefined): number | undefined {
  const base = (axis as { scaling?: { logBase?: number } } | undefined)?.scaling?.logBase;
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 1) {
    return undefined;
  }
  return base;
}

// `axisScaleLogBase` is retained as an alias for the existing call
// sites that use it for tick-label formatting; both helpers now read
// through `axisLogBase` so the validity gate is consistent.
const axisScaleLogBase = axisLogBase;

/**
 * Format a log-space tick value as its data-space equivalent.
 * `logValue` is the already-transformed coordinate (e.g. `2` on a
 * log10 axis); the returned string represents `base^logValue`
 * (e.g. `"100"`). Falls back to {@link formatAxisNumber} when the
 * inverse transform produces a non-finite number.
 */
function formatLogAxisNumber(logValue: number, logBase: number): string {
  const dataValue = Math.pow(logBase, logValue);
  if (!Number.isFinite(dataValue)) {
    return formatAxisNumber(logValue);
  }
  return formatAxisNumber(dataValue);
}

function buildGridlines(
  plot: ChartSceneRect,
  yAxis: ChartAxis | undefined,
  yRange: ValueRange,
  xAxis: ChartAxis | undefined,
  xRange: ValueRange,
  xCategories: readonly string[] = []
): ChartSceneLine[] {
  const lines: ChartSceneLine[] = [];
  // Y-axis major gridlines: horizontal lines across the plot (values
  // grow bottom→top). Rendered for column / line / area / scatter /
  // bubble charts where the value axis is vertical. Lines are placed
  // at the same positions as the axis's tick labels so both always
  // align — previously the renderer hard-coded 5 equal divisions
  // regardless of `majorUnit`, so any author-specified tick step
  // produced gridlines and labels at different positions.
  //
  // We iterate tick values in **descending** order (top→bottom in SVG
  // coordinates) so the emitted `<line>` sequence is stable across
  // refactors — matches the pre-existing auto-tick loop that walked
  // `i = 1..4` (top to bottom) and keeps SVG golden-hash snapshots
  // from churning when the gridline values didn't actually move.
  if (yAxis?.majorGridlines !== undefined) {
    const color = previewShapeLineColor(getSpPrLine(yAxis.majorGridlines)) ?? GRID_COLOR;
    if (yAxis.axisType === "cat" || yAxis.axisType === "ser") {
      // Horizontal bar charts put categories on the Y axis. Draw
      // horizontal lines at the boundaries *between* category slots
      // rather than at numeric tick positions. Without this, a
      // horizontal bar chart with `categoryAxis.majorGridlines` set
      // previously rendered lines at positions derived from the
      // unrelated X-axis numeric range.
      const count = Math.max(1, xCategories.length);
      const slot = plot.height / count;
      for (let i = 1; i < count; i++) {
        const y = plot.y + i * slot;
        lines.push({ x1: plot.x, y1: y, x2: plot.x + plot.width, y2: y, color });
      }
    } else {
      const ticks = valueAxisTickPositions(yRange.min, yRange.max, yAxis);
      for (let i = ticks.length - 1; i >= 0; i--) {
        const y = valueToY(ticks[i], yRange.min, yRange.max, plot);
        // Skip the bottom edge (the x-axis line coincides with it) and
        // the top edge (no visual value adding a gridline there);
        // matches Excel's own rendering.
        if (Math.abs(y - (plot.y + plot.height)) < 0.5 || Math.abs(y - plot.y) < 0.5) {
          continue;
        }
        lines.push({ x1: plot.x, y1: y, x2: plot.x + plot.width, y2: y, color });
      }
    }
  }
  // X-axis major gridlines: vertical lines down the plot (values grow
  // left→right). Rendered for horizontal bar charts and scatter /
  // bubble charts that also carry an X-axis `majorGridlines` element.
  // Previously ignored entirely — `buildGridlines` only consulted the
  // Y axis, so a horizontal bar chart with `valueAxis.majorGridlines`
  // rendered no gridlines at all (Excel draws vertical lines at each
  // tick for exactly this chart orientation).
  if (xAxis?.majorGridlines !== undefined) {
    const color = previewShapeLineColor(getSpPrLine(xAxis.majorGridlines)) ?? GRID_COLOR;
    if (xAxis.axisType === "cat" || xAxis.axisType === "ser") {
      // Column / line / area chart category axis on the X side. The
      // previous implementation fed the category x-axis through
      // `valueAxisTickPositions(xRange)` — but `xRange` for a
      // category chart is synthesised from the Y values via
      // `scatterXValues`, so ticks landed at numerically meaningful
      // positions that had nothing to do with category slots. Draw
      // vertical lines at category slot boundaries instead.
      const count = Math.max(1, xCategories.length);
      const groupWidth = plot.width / count;
      for (let i = 1; i < count; i++) {
        const x = plot.x + i * groupWidth;
        lines.push({ x1: x, y1: plot.y, x2: x, y2: plot.y + plot.height, color });
      }
    } else {
      const ticks = valueAxisTickPositions(xRange.min, xRange.max, xAxis);
      for (const value of ticks) {
        const x = valueToX(value, xRange.min, xRange.max, plot);
        if (Math.abs(x - plot.x) < 0.5 || Math.abs(x - (plot.x + plot.width)) < 0.5) {
          continue;
        }
        lines.push({ x1: x, y1: plot.y, x2: x, y2: plot.y + plot.height, color });
      }
    }
  }
  return lines;
}

function withAdornments<T extends ChartSceneSeries>(
  sceneSeries: T,
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number,
  categories: string[],
  xRange?: { min: number; max: number }
): T {
  const points = representativePoints(sceneSeries);
  const values = series.values;
  // Data labels should display the author's original numbers even when
  // the value axis is log-scaled. `series.values` has already been
  // passed through `applyAxisTransform` (to place the points at the
  // correct pixel y), so use `rawValues` for the label text; fall
  // back to the display values when no raw copy is available
  // (synthetic series used by a handful of legacy callers).
  const labelValues = series.rawValues ?? values;
  let labels = buildDataLabels(points, labelValues, categories, series, plot, sceneSeries);
  const markers = buildMarkers(points, series);
  const trendlines = buildTrendlines(points, values, series, plot, min, max);
  let leaderLines: ChartSceneLine[] | undefined;
  if (
    labels.length > 0 &&
    (sceneSeries.type === "pie" || sceneSeries.type === "doughnut" || sceneSeries.type === "ofPie")
  ) {
    const mergedLabels = mergeDataLabels(series.group, series.series);
    const position = mergedLabels?.position ?? "outEnd";
    if (position === "outEnd" || position === "bestFit") {
      const layout = layoutPieLabels(sceneSeries as ChartScenePieSeries, labels, plot);
      labels = layout.labels;
      leaderLines = layout.leaderLines;
    }
  } else if (labels.length > 1) {
    // For non-pie series, apply a generic greedy collision pass that
    // nudges overlapping labels vertically and hides labels that cannot
    // be separated even after nudging. Without this, dense bar/line
    // charts emit overlapping <text> glyphs at the same coordinates.
    labels = resolveLabelCollisions(labels, plot);
  }
  // Horizontal bars swap the value axis (normally Y) onto X — the
  // `min/max` this function receives is the *value* range regardless
  // of orientation, but whether that range maps to screen-Y or screen-X
  // depends on `sceneSeries.horizontal`. `buildErrorBars` needs the
  // orientation flag so the default (unauthored) error direction
  // matches Excel's "extend along the value axis" convention.
  const horizontal = sceneSeries.type === "bar" && sceneSeries.horizontal === true;
  const errorBars = buildErrorBars(
    points,
    values,
    series,
    plot,
    min,
    max,
    horizontal,
    xRange,
    series.xValues
  );
  return {
    ...sceneSeries,
    labels: labels.length > 0 ? labels : undefined,
    markers: markers.length > 0 ? markers : undefined,
    trendlines: trendlines.length > 0 ? trendlines : undefined,
    errorBars: errorBars.length > 0 ? errorBars : undefined,
    leaderLines: leaderLines && leaderLines.length > 0 ? leaderLines : undefined
  };
}

/**
 * Resolve label-to-label collisions for non-pie series (bar, line, scatter,
 * area). Labels are sorted left-to-right, pushed upward when the next
 * label's bounding box overlaps the previous one's, and dropped entirely
 * when even the maximum nudge would still overlap (so the user sees a
 * readable subset instead of an unreadable pile).
 *
 * The bounding box uses `estimateTextWidth` (real glyph metrics via
 * `@excel/utils/text-metrics`) so shorter labels deliberately leave room
 * for neighbours without forcing line breaks. This is the same algorithm
 * Chart.js uses for its default label layout — fast, deterministic, good
 * enough for 95% of bar/line previews without shipping a constraint
 * solver.
 */
function resolveLabelCollisions(labels: ChartSceneText[], plot: ChartSceneRect): ChartSceneText[] {
  const padding = 2;
  const topBound = plot.y + 4;
  const bottomBound = plot.y + plot.height - 4;
  interface Entry {
    label: ChartSceneText;
    left: number;
    right: number;
    width: number;
    height: number;
    kept: boolean;
  }
  const entries: Entry[] = labels.map(label => {
    const width = estimateTextWidth(label.text, label.fontSize);
    const height = label.fontSize;
    const anchor = label.anchor ?? "start";
    const left =
      anchor === "middle" ? label.x - width / 2 : anchor === "end" ? label.x - width : label.x;
    return {
      label,
      left,
      right: left + width,
      width,
      height,
      kept: true
    };
  });

  // Sort by horizontal centre so nudging cascades left-to-right; stable on
  // ties preserves input order for deterministic output.
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ax = a.entry.left + a.entry.width / 2;
      const bx = b.entry.left + b.entry.width / 2;
      return ax === bx ? a.index - b.index : ax - bx;
    });

  for (let i = 1; i < ordered.length; i++) {
    const curr = ordered[i].entry;
    // Find the nearest preceding kept neighbour whose bbox horizontally
    // overlaps ours; if any of its top edges clash vertically, push ours
    // above it. Iterate backwards so stacked neighbours chain.
    for (let j = i - 1; j >= 0; j--) {
      const prev = ordered[j].entry;
      if (!prev.kept) {
        continue;
      }
      const horizontallyApart = curr.left >= prev.right || prev.left >= curr.right;
      if (horizontallyApart) {
        continue;
      }
      const prevTop = prev.label.y - prev.height;
      const currTop = curr.label.y - curr.height;
      if (currTop + curr.height + padding > prevTop) {
        // Try nudging current label above the previous one first
        // (preserves the classic upward-only behaviour that callers
        // depend on for stacked bar labels).
        const newY = prevTop - padding;
        if (newY - curr.height >= topBound) {
          curr.label = { ...curr.label, y: newY };
          continue;
        }
        // Fallback: try nudging DOWNWARD past the previous label's
        // baseline. Excel's own label placement does the same when
        // outEnd/bestFit is asked and the upward slot is exhausted.
        // Previously this branch dropped the label entirely, so dense
        // charts lost labels systematically.
        const prevBottom = prev.label.y;
        const downY = prevBottom + curr.height + padding;
        if (downY <= bottomBound) {
          curr.label = { ...curr.label, y: downY };
          continue;
        }
        // Both directions exhausted — drop the label as a last resort.
        curr.kept = false;
        break;
      }
    }
  }

  return entries.filter(entry => entry.kept).map(entry => entry.label);
}

/**
 * Move pie/doughnut data labels to the outside of each slice and emit
 * leader lines connecting the slice arc to the label anchor.
 *
 * Excel's `outEnd` (and `bestFit`, which resolves to the same thing for
 * pie-style charts) places each label along the angular bisector of its
 * slice, just past the outer radius. To keep neighbouring labels from
 * colliding we apply a greedy vertical nudge on each side of the pie:
 * labels are grouped by `left` (π/2 < θ < 3π/2) vs `right` hemisphere,
 * sorted by y, and then shifted downward one-by-one when the next label
 * overlaps its predecessor. The leader line ends on the slice arc (using
 * the original inward anchor) and kinks once at the outer ring so the
 * shape matches Excel's standard "radial + bend" callout rather than a
 * single diagonal.
 *
 * The nudge is intentionally simple — it resolves 95% of common collision
 * cases without pulling in a constraint solver. Extreme datasets (many
 * thin slices packed on one side) may still overlap; those belong to
 * the external oracle gap, not to this preview.
 */
function layoutPieLabels(
  series: ChartScenePieSeries,
  rawLabels: ChartSceneText[],
  plot: ChartSceneRect
): { labels: ChartSceneText[]; leaderLines: ChartSceneLine[] } {
  const allSlices = [...series.slices, ...(series.secondarySlices ?? [])];
  if (allSlices.length !== rawLabels.length) {
    // Defensive: if the adornment builder produced a different label count
    // (e.g. future dataPoint overrides) just return the input unchanged so
    // callers fall back to the interior placement that was working before.
    return { labels: rawLabels, leaderLines: [] };
  }

  const labelOffset = 14;
  interface Entry {
    index: number;
    slice: ChartScenePieSlice;
    angle: number;
    side: "left" | "right";
    anchorX: number;
    anchorY: number;
    x: number;
    y: number;
    text: string;
    fontSize: number;
    color: string;
    textAnchor: "start" | "end";
    /**
     * Set when `nudge` cannot place this label within the plot
     * rectangle. Filtered out of both the rendered label array and
     * the leader-line array so the preview never draws an
     * overlapping pile at the plot edge.
     */
    _dropped?: boolean;
  }
  const entries: Entry[] = allSlices.map((slice, i) => {
    const angle = (slice.startAngle + slice.endAngle) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const anchorX = slice.cx + cos * slice.radius;
    const anchorY = slice.cy + sin * slice.radius;
    // Right hemisphere: label aligned start; left hemisphere: aligned end.
    const side: "left" | "right" = cos >= 0 ? "right" : "left";
    const x = anchorX + cos * labelOffset;
    const y = anchorY + sin * labelOffset;
    const raw = rawLabels[i];
    return {
      index: i,
      slice,
      angle,
      side,
      anchorX,
      anchorY,
      x,
      y,
      text: raw.text,
      fontSize: raw.fontSize,
      color: raw.color,
      textAnchor: side === "left" ? "end" : "start"
    };
  });

  // Greedy collision avoidance per hemisphere: sort top→bottom and push
  // each label below its predecessor's baseline + fontSize. Labels that
  // cannot fit within `[topBound, bottomBound]` are dropped entirely
  // rather than clamped to the bound — clamping previously collapsed
  // every overflow entry onto the same y coordinate, producing an
  // unreadable pile of overlapping labels at the plot edge. Dropped
  // entries are marked by setting `_dropped = true` so the caller can
  // filter them out of both the label and leader-line lists.
  const nudge = (hemisphere: Entry[]): void => {
    hemisphere.sort((a, b) => a.y - b.y);
    const topBound = plot.y + 4;
    const bottomBound = plot.y + plot.height - 4;
    // Forward pass: nudge each label below its predecessor.
    for (let i = 0; i < hemisphere.length; i++) {
      const e = hemisphere[i];
      if (i === 0) {
        e.y = Math.max(e.y, topBound);
        continue;
      }
      const prev = hemisphere[i - 1];
      // Skip dropped predecessors so their clamped y doesn't push us
      // past the bound on the very first item.
      if (prev._dropped) {
        e.y = Math.max(e.y, topBound);
        continue;
      }
      const minY = prev.y + prev.fontSize + 2;
      if (e.y < minY) {
        e.y = minY;
      }
      if (e.y > bottomBound) {
        // Try a reverse pass recovery: if the stack runs out of room
        // at the bottom, drop this label — the alternative of pinning
        // every overflowing label to `bottomBound` created an opaque
        // overlap pile that conveyed no information.
        e._dropped = true;
      }
    }
  };
  nudge(entries.filter(e => e.side === "left"));
  nudge(entries.filter(e => e.side === "right"));

  // Clamp horizontal position so labels don't escape the plot rectangle.
  for (const e of entries) {
    if (e.side === "right") {
      e.x = Math.min(e.x, plot.x + plot.width - 4);
    } else {
      e.x = Math.max(e.x, plot.x + 4);
    }
  }

  // Filter out entries marked `_dropped` (label couldn't fit without
  // overlapping). Dropping rather than stacking preserves readability
  // at the cost of occasional missing labels — preview callers that
  // care about complete coverage should increase the plot height.
  const keep = entries.filter(e => !e._dropped);
  const labels: ChartSceneText[] = keep.map(e => ({
    x: e.x,
    y: e.y,
    text: e.text,
    fontSize: e.fontSize,
    color: e.color,
    anchor: e.textAnchor === "end" ? "end" : "start"
  }));
  const leaderLines: ChartSceneLine[] = keep.map(e => ({
    x1: e.anchorX,
    y1: e.anchorY,
    x2: e.x - (e.side === "right" ? 4 : -4),
    y2: e.y - e.fontSize / 3,
    color: "#808080",
    width: 1
  }));
  return { labels, leaderLines };
}

function representativePoints(series: ChartSceneSeries): ChartScenePoint[] {
  if (series.type === "bar") {
    // Anchor data labels / markers / error bars on the value-end edge
    // of each bar. For vertical bars (columns) that's the centre-top
    // (`bar.x + width/2, bar.y`); for horizontal bars it's the right-
    // middle (`bar.x + width, bar.y + height/2`) — previously both
    // orientations used the column anchor, which placed labels inside
    // an upward-growing horizontal bar's body instead of at its value
    // tip.
    if (series.horizontal) {
      return series.bars.map(bar => ({
        x: bar.x + bar.width,
        y: bar.y + bar.height / 2
      }));
    }
    return series.bars.map(bar => ({ x: bar.x + bar.width / 2, y: bar.y }));
  }
  if (
    series.type === "area" ||
    series.type === "line" ||
    series.type === "scatter" ||
    series.type === "radar"
  ) {
    return series.points;
  }
  if (series.type === "bubble") {
    return series.bubbles.map(b => ({ x: b.x, y: b.y }));
  }
  if (series.type === "pie" || series.type === "doughnut" || series.type === "ofPie") {
    return [...series.slices, ...(series.secondarySlices ?? [])].map(slice => {
      const a = (slice.startAngle + slice.endAngle) / 2;
      const r = (slice.radius + slice.innerRadius) / 2;
      return { x: slice.cx + Math.cos(a) * r, y: slice.cy + Math.sin(a) * r };
    });
  }
  if (series.type === "stock") {
    return series.candles.map(c => ({ x: c.x, y: c.closeY ?? c.lowY }));
  }
  if (series.type === "surface") {
    return series.cells.map(cell => ({ x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 }));
  }
  return [];
}

function buildDataLabels(
  points: ChartScenePoint[],
  values: number[],
  categories: string[],
  series: NormalizedSeries,
  plot: ChartSceneRect,
  sceneSeries?: ChartSceneSeries
): ChartSceneText[] {
  const labels = mergeDataLabels(series.group, series.series);
  if (!labels?.showVal && !labels?.showCatName && !labels?.showSerName && !labels?.showPercent) {
    return [];
  }
  // When data points exceed a readable density, sample evenly so the
  // chart still shows representative labels without turning into
  // illegible noise. Excel renders all of them (relying on zoom), but
  // for a static-resolution PDF preview we cap at ~30 visible labels
  // spaced evenly across the series.
  const MAX_DATA_LABELS = 30;
  let labelPoints = points;
  let labelValues = values;
  let labelCategories = categories;
  if (points.length > MAX_DATA_LABELS) {
    const step = points.length / MAX_DATA_LABELS;
    const sampled: number[] = [];
    for (let i = 0; i < MAX_DATA_LABELS; i++) {
      sampled.push(Math.round(i * step));
    }
    labelPoints = sampled.map(i => points[i]);
    labelValues = sampled.map(i => values[i]);
    labelCategories = sampled.map(i => categories[i]);
  }
  // Percentage totals use the sum of absolute magnitudes so slices with
  // mixed-sign values still sum to 100 %. See `makeDataLabelText` for
  // the matching per-slice formula (`|v| / Σ|v|`). Previously the
  // total folded via `Math.max(0, v)` (dropping negatives), producing
  // asymmetric percentages that didn't match the pie's rendered wedges.
  //
  // For `ofPie` the primary and secondary pies each have their own
  // angular total (derived from their own slice of the values array).
  // Before this split, every `ofPie` label's percentage was computed
  // against the COMBINED series total — so a slice showing "100 %" of
  // the secondary pie was labelled at its fraction of the whole series
  // instead (e.g. 13 % of 78 %). Build the two per-pie totals up front
  // when the scene says we're rendering an `ofPie`, and pick per-index
  // below so every label matches the pie its slice actually occupies.
  // Sum magnitudes with a NaN guard. `collectNumberValues` emits `NaN`
  // for blanks / error cells, and `Math.abs(NaN)` is `NaN` — a single
  // gap would collapse the whole total to `NaN`, and then `NaN || 1`
  // silently substitutes `1`, making every per-slice percentage
  // evaluate to `Math.round(|v|/1 * 100)` (i.e. "1000 %" for v=10).
  // Matches the guard already in `buildPieSeries`.
  const sumAbsFinite = (arr: readonly number[]): number =>
    arr.reduce((sum, v) => sum + (Number.isFinite(v) ? Math.abs(v) : 0), 0);
  const overallTotal = sumAbsFinite(values) || 1;
  let ofPieSplit = -1;
  let primaryOfPieTotal = overallTotal;
  let secondaryOfPieTotal = overallTotal;
  if (sceneSeries?.type === "ofPie") {
    // `buildOfPieSeries` stores the primary slices in `slices` and the
    // rest in `secondarySlices`; we use the primary slice count as the
    // split index. When either bag is empty we fall back to the
    // overall total so the `|| 1` divide-by-zero guard still applies.
    ofPieSplit = sceneSeries.slices.length;
    const primaryValues = values.slice(0, ofPieSplit);
    const secondaryValues = values.slice(ofPieSplit);
    primaryOfPieTotal = sumAbsFinite(primaryValues) || 1;
    secondaryOfPieTotal = sumAbsFinite(secondaryValues) || 1;
  }
  const position = labels.position ?? "outEnd";
  const labelStyle = textStyleFromTxPr(labels.txPr);
  const labelColor = colorFromChartTextProperties(labels.txPr) ?? "#333333";
  // For bar / column series, the representative `point` is the
  // value-end of each bar. Some positions (`inBase`, `ctr`) need the
  // bar's *other* endpoint — e.g. `inBase` on a vertical column means
  // "at the baseline", which is the *bottom* of the bar (`bar.y +
  // bar.height`), not `point.y + 16px` (near the top). Pre-compute the
  // per-bar base anchor and pass it to `positionDataLabel` when the
  // sceneSeries is a bar.
  const baseAnchors: ChartScenePoint[] | undefined =
    sceneSeries?.type === "bar"
      ? sceneSeries.bars.map(bar =>
          sceneSeries.horizontal
            ? { x: bar.x, y: bar.y + bar.height / 2 }
            : { x: bar.x + bar.width / 2, y: bar.y + bar.height }
        )
      : undefined;
  return labelPoints.map((point, i) => {
    const entry = labels.entries?.find(e => e.index === i);
    const effectivePosition = entry?.position ?? position;
    const { x, y, anchor } = positionDataLabel(
      point,
      effectivePosition,
      plot,
      baseAnchors?.[i],
      sceneSeries?.type === "bar" ? sceneSeries.horizontal : false
    );
    // Resolve the total this particular label should compare against.
    // Pie and doughnut use the series total; ofPie uses per-pie totals
    // so each label's percentage reflects its wedge's share of the
    // pie it visually occupies.
    const effectiveTotal =
      ofPieSplit >= 0 ? (i < ofPieSplit ? primaryOfPieTotal : secondaryOfPieTotal) : overallTotal;
    return {
      x,
      y,
      text: makeDataLabelText(
        labels,
        series,
        labelCategories[i],
        labelValues[i] ?? 0,
        effectiveTotal
      ),
      fontSize: 10,
      color: labelColor,
      anchor,
      ...labelStyle
    };
  });
}

/**
 * Resolve a logical `DataLabelPosition` into concrete SVG text coordinates.
 *
 * The preview renderer does not know the full geometry of every mark (bars
 * vs. markers vs. slices), so this function operates on the scene `point`
 * (which is already the mark's centre or outer-end anchor, depending on how
 * the series type built it). The mapping matches Excel's user-visible
 * positions as closely as possible for deterministic previews:
 *
 * - `t` / `outEnd` → above the point, centred
 * - `b` / `inBase` → below the point, centred
 * - `l` → left of the point, right-anchored
 * - `r` → right of the point, left-anchored
 * - `ctr` / `inEnd` / `bestFit` → at the point, centred
 *
 * `plot` is used to keep the label inside the plot rectangle for edge cases.
 */
function positionDataLabel(
  point: ChartScenePoint,
  position: DataLabelPosition,
  plot: ChartSceneRect,
  baseAnchor?: ChartScenePoint,
  horizontalBar = false
): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  const offset = 6;
  const minY = plot.y + 10;
  const maxY = plot.y + plot.height - 4;
  const minX = plot.x + 4;
  const maxX = plot.x + plot.width - 4;
  switch (position) {
    case "t":
    case "outEnd":
      if (horizontalBar) {
        // `outEnd` on a horizontal bar extends past the value-tip.
        return {
          x: Math.min(maxX, point.x + offset),
          y: point.y + 3,
          anchor: "start"
        };
      }
      return {
        x: point.x,
        y: Math.max(minY, point.y - offset),
        anchor: "middle"
      };
    case "inBase":
      // `inBase` = inside the bar at the base (the axis-crossing end).
      // For a vertical column that's the bottom of the bar (`bar.y +
      // bar.height`); for a horizontal bar, the left edge (`bar.x`).
      // Without `baseAnchor` (pie / line / scatter) `inBase` has no
      // well-defined meaning — fall back to the point-below behaviour
      // used by the `b` position.
      if (baseAnchor) {
        if (horizontalBar) {
          return {
            x: Math.max(minX, baseAnchor.x + offset),
            y: baseAnchor.y + 3,
            anchor: "start"
          };
        }
        return {
          x: baseAnchor.x,
          y: Math.min(maxY, baseAnchor.y - offset),
          anchor: "middle"
        };
      }
      return {
        x: point.x,
        y: Math.min(maxY, point.y + offset + 10),
        anchor: "middle"
      };
    case "b":
      return {
        x: point.x,
        y: Math.min(maxY, point.y + offset + 10),
        anchor: "middle"
      };
    case "l":
      return {
        x: Math.max(minX, point.x - offset),
        y: point.y + 3,
        anchor: "end"
      };
    case "r":
      return {
        x: Math.min(maxX, point.x + offset),
        y: point.y + 3,
        anchor: "start"
      };
    case "ctr":
      // `ctr` = dead centre of the shape. For a bar, that's the midpoint
      // between the value-tip (`point`) and the baseline anchor; fall
      // back to the point for non-bar series.
      if (baseAnchor) {
        return {
          x: (point.x + baseAnchor.x) / 2,
          y: (point.y + baseAnchor.y) / 2 + 3,
          anchor: "middle"
        };
      }
      return {
        x: point.x,
        y: point.y + 3,
        anchor: "middle"
      };
    case "inEnd":
    case "bestFit":
    default:
      return {
        x: point.x,
        y: point.y + 3,
        anchor: "middle"
      };
  }
}

function buildMarkers(points: ChartScenePoint[], series: NormalizedSeries): ChartSceneMarker[] {
  const marker = series.marker;
  if (!marker || marker.symbol === "none") {
    return [];
  }
  return points.map(point => ({
    ...point,
    color: series.color,
    size: marker.size ?? 6,
    symbol: marker.symbol ?? "circle"
  }));
}

function buildTrendlines(
  points: ChartScenePoint[],
  values: number[],
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartSceneTrendline[] {
  if (!series.trendlines || points.length < 2) {
    return [];
  }
  return series.trendlines.map(trendline => {
    const trendPoints = computeTrendlinePoints(trendline, points, values, series, plot, min, max);
    // `trendPoints` can be empty when the trendline helper rejected
    // the input (e.g. movingAvg period larger than window, or not
    // enough positive values for exp/log/power). Reading
    // `trendPoints[length-1].x` on an empty array crashes — guard so
    // a malformed series still renders the rest of the chart.
    const lastPoint = trendPoints.length > 0 ? trendPoints[trendPoints.length - 1] : undefined;
    return {
      color:
        previewShapeLineColor(trendline.spPr ? getSpPrLine(trendline.spPr) : undefined) ??
        "#666666",
      // Reuse `previewShapeLineWidthPx` so the EMU→pt conversion, the
      // `0.5pt` minimum stroke, and the `undefined`-when-absent
      // behaviour match every other line-style consumer. The previous
      // inline expression (`width ? width/12700 : 1.5`) treated any
      // falsy width — including the perfectly valid `0` — as absent.
      width:
        previewShapeLineWidthPx(trendline.spPr ? getSpPrLine(trendline.spPr) : undefined) ?? 1.5,
      dash: trendline.spPr?.line?.dash,
      points: trendPoints,
      label:
        trendline.name && lastPoint
          ? {
              x: lastPoint.x,
              y: lastPoint.y - 8,
              text: trendline.name,
              fontSize: 10,
              color: "#555555",
              anchor: "end"
            }
          : undefined
    };
  });
}

function buildErrorBars(
  points: ChartScenePoint[],
  values: number[],
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number,
  horizontal = false,
  xRange?: { min: number; max: number },
  xValues?: number[]
): ChartSceneErrorBar[] {
  if (!series.errorBars || points.length === 0) {
    return [];
  }
  const bars: ChartSceneErrorBar[] = [];
  for (const err of series.errorBars) {
    const color = previewShapeLineColor(err.spPr ? getSpPrLine(err.spPr) : undefined) ?? "#555555";
    // Honour `barDir` ("plus" / "minus" / "both") and `errDir`
    // ("x" / "y"). Previously the renderer ignored both fields and
    // always drew a full-both-sides vertical error bar for every
    // configuration — "plus"-only error bars silently extended below
    // the data point, and horizontal (x-direction) errors on scatter /
    // bubble series rendered as vertical bars anchored at the wrong
    // axis.
    //
    // Default direction depends on the series orientation. Vertical
    // bars / columns / line / area extend along the Y axis (`y`), so
    // the unspecified default is `y`. Horizontal bars swap the value
    // axis onto X, so their default becomes `x` — the previous
    // unconditional `y` default drew vertical error whiskers across
    // a horizontal bar chart instead of extending along the value
    // axis.
    const direction = err.errDir === "x" ? "x" : err.errDir === "y" ? "y" : horizontal ? "x" : "y";
    const showPlus = err.barDir === "plus" || err.barDir === "both";
    const showMinus = err.barDir === "minus" || err.barDir === "both";
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const value = values[i];
      // Skip gaps — `collectNumberValues` encodes blank cells as NaN
      // so downstream segmentation can drop them. `p.x`/`p.y` for a
      // gap point are also NaN (via `valueToY(NaN, …)`), and `fmt(NaN)`
      // silently emits `"0"` into SVG attributes. Without this guard
      // every gap produced an error bar spiking to `(0, 0)` — a
      // visible cross at the top-left of the plot.
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(value)) {
        continue;
      }
      const { plus: plusAmount, minus: minusAmount } = errorAmounts(err, value, values, i);
      if (direction === "x") {
        // Horizontal error bar: extend along the value axis. For
        // horizontal bars the value axis *is* the X axis and `min`/`max`
        // are the value range, so we derive the pixel delta from those
        // directly. For scatter / bubble x-direction errors the value
        // lives at `xValues[i]` and scales against `xRange`.
        let baseValue: number;
        let lo: number;
        let hi: number;
        if (horizontal) {
          baseValue = value;
          lo = min;
          hi = max;
        } else if (xRange && xValues) {
          const xv = xValues[i];
          if (!Number.isFinite(xv)) {
            continue;
          }
          baseValue = xv;
          lo = xRange.min;
          hi = xRange.max;
        } else {
          // No x-axis context (legacy caller, category series). Fall
          // back to `p.x ± pixelAmount` with the value-range scale — a
          // coarse approximation, but better than silently producing
          // an infinitely-long whisker.
          baseValue = value;
          lo = min;
          hi = max;
        }
        const plusX = showPlus
          ? Math.max(
              plot.x,
              Math.min(
                plot.x + plot.width,
                valueToX(baseValue + plusAmount, lo, hi === lo ? lo + 1 : hi, plot)
              )
            )
          : p.x;
        const minusX = showMinus
          ? Math.max(
              plot.x,
              Math.min(
                plot.x + plot.width,
                valueToX(baseValue - minusAmount, lo, hi === lo ? lo + 1 : hi, plot)
              )
            )
          : p.x;
        bars.push({
          line: { x1: minusX, y1: p.y, x2: plusX, y2: p.y, color },
          cap1:
            err.noEndCap || !showPlus
              ? undefined
              : { x1: plusX, y1: p.y - 4, x2: plusX, y2: p.y + 4, color },
          cap2:
            err.noEndCap || !showMinus
              ? undefined
              : { x1: minusX, y1: p.y - 4, x2: minusX, y2: p.y + 4, color }
        });
        continue;
      }
      const plusY = showPlus
        ? Math.max(
            plot.y,
            Math.min(plot.y + plot.height, valueToY(value + plusAmount, min, max, plot))
          )
        : p.y;
      const minusY = showMinus
        ? Math.max(
            plot.y,
            Math.min(plot.y + plot.height, valueToY(value - minusAmount, min, max, plot))
          )
        : p.y;
      bars.push({
        line: { x1: p.x, y1: plusY, x2: p.x, y2: minusY, color },
        cap1:
          err.noEndCap || !showPlus
            ? undefined
            : { x1: p.x - 4, y1: plusY, x2: p.x + 4, y2: plusY, color },
        cap2:
          err.noEndCap || !showMinus
            ? undefined
            : { x1: p.x - 4, y1: minusY, x2: p.x + 4, y2: minusY, color }
      });
    }
  }
  return bars;
}

function buildXLabels(
  categories: string[],
  plot: ChartSceneRect,
  axis?: ChartAxis,
  range?: ValueRange,
  top = false
): ChartSceneText[] {
  if (axis?.delete || axis?.tickLblPos === "none") {
    return [];
  }
  if (axis?.axisType === "val") {
    const { min, max } = range ?? { min: 0, max: 1 };
    return buildValueXLabels(min, max, plot, axis, top);
  }
  const count = Math.max(1, categories.length);
  const groupWidth = plot.width / count;
  let skip = axis?.axisType === "cat" || axis?.axisType === "ser" ? (axis.tickLblSkip ?? 1) : 1;
  // When the category count is much larger than MAX_VISIBLE_LABELS,
  // auto-increase skip so labels are sampled evenly across the full
  // axis width. Show up to 60 labels for dense charts.
  const safeSkip = Math.max(1, skip);
  const MAX_VISIBLE_LABELS = 60;
  const candidateCount = Math.ceil(categories.length / safeSkip);
  if (candidateCount > MAX_VISIBLE_LABELS) {
    skip = Math.ceil(categories.length / MAX_VISIBLE_LABELS);
  }
  const effectiveSkip = Math.max(1, skip);
  const visibleEntries: Array<{ label: string; idx: number }> = [];
  for (let i = 0; i < categories.length; i++) {
    if (i % effectiveSkip !== 0) {
      continue;
    }
    visibleEntries.push({ label: categories[i], idx: i });
    if (visibleEntries.length >= MAX_VISIBLE_LABELS) {
      break;
    }
  }
  const axisStyle = textStyleFromTxPr(axis?.txPr);
  // When categories are dense, rotate labels 90° (head-left, foot-right)
  // to match Excel's vertical tick label rendering.
  const shouldRotate = categories.length > 6;
  return visibleEntries.map(({ label, idx }) => {
    return {
      x: plot.x + idx * groupWidth + groupWidth / 2,
      y: top ? plot.y - 10 : plot.y + plot.height + 18,
      text: truncateLabel(label),
      fontSize: 10,
      color: tickLabelColor(axis),
      anchor: shouldRotate ? ("end" as const) : ("middle" as const),
      rotate: shouldRotate ? -90 : undefined,
      ...axisStyle
    };
  });
}

function buildValueXLabels(
  min: number,
  max: number,
  plot: ChartSceneRect,
  axis: ChartAxis | undefined,
  top: boolean
): ChartSceneText[] {
  const labels: ChartSceneText[] = [];
  const color = tickLabelColor(axis);
  const axisStyle = textStyleFromTxPr(axis?.txPr);
  const logBase = axisScaleLogBase(axis);
  // Use the shared tick-position helper so axis labels align with the
  // gridlines drawn by `buildGridlines`. Previously this function
  // hardcoded 6 evenly-spaced labels (5 intervals) regardless of the
  // author's `majorUnit` — labels and gridlines then drifted apart on
  // any chart that set a custom tick step.
  for (const value of valueAxisTickPositions(min, max, axis)) {
    labels.push({
      x: valueToX(value, min, max, plot),
      y: top ? plot.y - 10 : plot.y + plot.height + 18,
      text: logBase ? formatLogAxisNumber(value, logBase) : formatAxisNumber(value),
      fontSize: 10,
      color,
      anchor: "middle",
      ...axisStyle
    });
  }
  return labels;
}

function buildYLabels(
  min: number,
  max: number,
  plot: ChartSceneRect,
  axis?: ChartAxis,
  right = false,
  categories: readonly string[] = []
): ChartSceneText[] {
  if (axis?.delete || axis?.tickLblPos === "none") {
    return [];
  }
  const labels: ChartSceneText[] = [];
  const color = tickLabelColor(axis);
  const axisStyle = textStyleFromTxPr(axis?.txPr);
  // Category / series axes on a horizontal-bar-style Y axis should
  // render as category names, not numeric quintiles. Excel places the
  // value axis at the bottom for `barDir="bar"` and the category axis
  // on the left; the category axis has `axisType === "cat"`. The
  // previous buildYLabels always called `formatAxisNumber`, emitting
  // `"0"`, `"0.4"`, … next to bars whose actual categories lived on
  // this axis — typical horizontal bar chart rendered with blank /
  // numeric Y labels instead of the category names.
  if ((axis?.axisType === "cat" || axis?.axisType === "ser") && categories.length > 0) {
    const skip = axis.tickLblSkip ?? 1;
    const safeSkip = Math.max(1, skip);
    const MAX_VISIBLE_LABELS = 12;
    const slot = plot.height / Math.max(1, categories.length);
    const visibleEntries: Array<{ label: string; idx: number }> = [];
    for (let i = 0; i < categories.length; i++) {
      if (i % safeSkip !== 0) {
        continue;
      }
      visibleEntries.push({ label: categories[i], idx: i });
      if (visibleEntries.length >= MAX_VISIBLE_LABELS) {
        break;
      }
    }
    for (const { label, idx } of visibleEntries) {
      labels.push({
        x: right ? plot.x + plot.width + 8 : plot.x - 8,
        y: plot.y + idx * slot + slot / 2 + 3,
        text: truncateLabel(label),
        fontSize: 10,
        color,
        anchor: right ? "start" : "end",
        ...axisStyle
      });
    }
    return labels;
  }
  // Use the shared tick-position helper so value-axis labels align with
  // the gridlines `buildGridlines` draws.
  const logBase = axisScaleLogBase(axis);
  for (const value of valueAxisTickPositions(min, max, axis)) {
    labels.push({
      x: right ? plot.x + plot.width + 8 : plot.x - 8,
      y: valueToY(value, min, max, plot) + 3,
      text: logBase ? formatLogAxisNumber(value, logBase) : formatAxisNumber(value),
      fontSize: 10,
      color,
      anchor: right ? "start" : "end",
      ...axisStyle
    });
  }
  return labels;
}

function normalizeSeries(groups: ChartTypeGroup[], model?: ChartModel): NormalizedSeries[] {
  // Resolve the axis log transform *per group* rather than once for the
  // whole chart. Combo charts (`c:barChart` + `c:lineChart` sharing a
  // plot area) routinely bind groups to different value axes via
  // `c:axId` — a primary axis can be linear while the secondary is a
  // log scale (or vice versa). The previous implementation took the
  // first axis it found and applied that log base to every series,
  // which silently corrupted the secondary-axis series in combo charts
  // with heterogeneous scales.
  //
  // OOXML forbids non-positive values on log axes, but the renderer is
  // preview-grade and refusing to render is worse than placing them at
  // the axis floor. Negative values pass through unchanged (see
  // {@link applyAxisTransform}).
  const axes = model?.chart?.plotArea?.axes;
  const axesById = new Map<number, ChartAxis>();
  if (axes) {
    for (const ax of axes) {
      axesById.set(ax.axId, ax);
    }
  }
  const logBaseCache = new Map<ChartTypeGroup, { yLogBase?: number; xLogBase?: number }>();
  const getGroupLogBases = (group: ChartTypeGroup): { yLogBase?: number; xLogBase?: number } => {
    const cached = logBaseCache.get(group);
    if (cached) {
      return cached;
    }
    const axisIds = (group as { axisIds?: number[] }).axisIds ?? [];
    const yAxisId = getYAxisIdForGroup(group, axisIds, axesById);
    const xAxisId = getXAxisIdForGroup(group, axisIds, axesById);
    const resolved = {
      yLogBase: axisLogBase(yAxisId !== undefined ? axesById.get(yAxisId) : undefined),
      xLogBase: axisLogBase(xAxisId !== undefined ? axesById.get(xAxisId) : undefined)
    };
    logBaseCache.set(group, resolved);
    return resolved;
  };

  const normalized: NormalizedSeries[] = [];
  let globalIndex = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    const series = collectSeries(group);
    const { yLogBase, xLogBase } = getGroupLogBases(group);
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
      const s = series[seriesIndex];
      const rawValues = collectValues(s);
      const rawXValues = collectAxisValues((s as { xVal?: AxisDataSource }).xVal);
      normalized.push({
        group,
        groupIndex,
        series: s,
        seriesIndex,
        globalIndex,
        label: collectSeriesLabel(s, globalIndex),
        color: seriesColor(s, globalIndex),
        values: yLogBase
          ? rawValues.map(v => (typeof v === "number" ? applyAxisTransform(v, yLogBase) : v))
          : rawValues,
        categories: collectCategories(s),
        xValues: xLogBase
          ? rawXValues.map(v => (typeof v === "number" ? applyAxisTransform(v, xLogBase) : v))
          : rawXValues,
        rawValues,
        rawXValues: rawXValues.length > 0 ? rawXValues : undefined,
        yLogBase,
        xLogBase,
        bubbleSizes: collectNumberValues(
          (s as { bubbleSize?: { numRef?: NumberReference } }).bubbleSize?.numRef
        ),
        dataLabels: (s as { dataLabels?: DataLabels }).dataLabels,
        trendlines: (s as { trendlines?: Trendline[] }).trendlines,
        errorBars: normalizeErrorBars((s as { errorBars?: ErrorBars | ErrorBars[] }).errorBars),
        marker: (s as { marker?: ChartMarker }).marker
      });
      globalIndex++;
    }
  }
  return normalized;
}

function seriesColor(series: SeriesBase, index: number): string {
  return (
    previewShapeFillColor(series.spPr ? getSpPrFill(series.spPr) : undefined, undefined) ??
    COLORS[index % COLORS.length]
  );
}

/**
 * Generic collector that iterates `series.dataPoints[]` and extracts a
 * per-point value using the supplied `extractor` function. Returns a sparse
 * array keyed by `dataPoint.index`; callers combine the result with their
 * default palette or zero-value fallback.
 */
function collectDataPointProperty<T>(
  series: NormalizedSeries | undefined,
  extractor: (dp: DataPoint) => T | undefined
): Array<T | undefined> {
  const out: Array<T | undefined> = [];
  if (!series) {
    return out;
  }
  const dataPoints = (series.series as SeriesBase & { dataPoints?: DataPoint[] }).dataPoints;
  if (!dataPoints) {
    return out;
  }
  for (const dp of dataPoints) {
    if (typeof dp.index !== "number" || dp.index < 0) {
      continue;
    }
    const value = extractor(dp);
    if (value !== undefined) {
      out[dp.index] = value;
    }
  }
  return out;
}

function collectDataPointColors(series: NormalizedSeries | undefined): Array<string | undefined> {
  return collectDataPointProperty(
    series,
    dp => previewShapeFillColor(dp.spPr ? getSpPrFill(dp.spPr) : undefined, undefined) || undefined
  );
}

/**
 * Collect per-point `explosion` values from `series.dataPoints[]`.
 * Excel stores explosion as an integer percentage (0–400) of the pie
 * radius — non-zero values push the matching slice outward along its
 * angle bisector. Returns a sparse array keyed by `dataPoint.index`;
 * callers treat absent slots as `0` (no explosion).
 */
function collectDataPointExplosions(
  series: NormalizedSeries | undefined
): Array<number | undefined> {
  return collectDataPointProperty(series, dp =>
    typeof dp.explosion === "number" && Number.isFinite(dp.explosion) && dp.explosion > 0
      ? dp.explosion
      : undefined
  );
}

/**
 * Map OOXML `CT_DoughnutChart/holeSize` (0–90, percent of radius) to
 * a usable inner-radius ratio. Clamp to the legal range so malformed
 * models don't produce a negative or overlarge hole that collides
 * with the outer arc. The `?? 45` fallback matches Excel's default
 * hole size for a freshly authored doughnut.
 */
function resolveDoughnutHoleRatio(holeSize: number | undefined): number {
  const percent =
    typeof holeSize === "number" && Number.isFinite(holeSize)
      ? Math.max(0, Math.min(90, holeSize))
      : 45;
  return percent / 100;
}

function normalizeErrorBars(value: ErrorBars | ErrorBars[] | undefined): ErrorBars[] | undefined {
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function buildAxisContext(model: ChartModel, normalized: NormalizedSeries[]): ChartAxisContext {
  const axes = model.chart.plotArea.axes;
  const axesById = new Map(axes.map(axis => [axis.axId, axis]));
  const axisIdsByGroup = new Map<ChartTypeGroup, number[]>();
  for (const group of model.chart.plotArea.chartTypes) {
    axisIdsByGroup.set(group, (group as { axisIds?: number[] }).axisIds ?? []);
  }
  const defaultYRange = getValueRange(
    normalized.map(s => s.values),
    undefined
  );
  const defaultXRange = getValueRange(
    normalized.map(s => scatterXValues(s)),
    undefined,
    { includeZero: false, padding: 0.05 }
  );
  const yValuesByAxisId = new Map<number, number[][]>();
  const xValuesByAxisId = new Map<number, number[][]>();
  // Group normalised series by their parent ChartTypeGroup so stacked
  // groups contribute per-category stacked sums (rather than raw
  // per-series values) to the axis range. Without this, a stacked
  // column/bar/area chart whose cumulative height exceeds any single
  // series' max would overflow the plot rectangle — `buildStackedBars`
  // / `buildStackedAreaBand` compute positions from the full stacked
  // total, but `getValueRange` was seeing only per-series maxima.
  const seriesByGroup = new Map<ChartTypeGroup, NormalizedSeries[]>();
  for (const series of normalized) {
    const bucket = seriesByGroup.get(series.group);
    if (bucket) {
      bucket.push(series);
    } else {
      seriesByGroup.set(series.group, [series]);
    }
  }
  for (const [group, groupSeries] of seriesByGroup) {
    const ids = axisIdsByGroup.get(group) ?? [];
    const isStacked =
      isStackableGroup(group) &&
      "grouping" in group &&
      (group.grouping === "stacked" || group.grouping === "percentStacked");
    const isPercent = isStacked && "grouping" in group && group.grouping === "percentStacked";
    for (const series of groupSeries) {
      const yAxisId = getYAxisIdForGroup(series.group, ids, axesById);
      const xAxisId = getXAxisIdForGroup(series.group, ids, axesById);
      if (yAxisId !== undefined && !isStacked) {
        addAxisValues(yValuesByAxisId, yAxisId, series.values);
      }
      if (xAxisId !== undefined && isValueValueGroup(series.group)) {
        addAxisValues(xValuesByAxisId, xAxisId, scatterXValues(series));
      }
    }
    if (isStacked) {
      const yAxisId = getYAxisIdForGroup(groupSeries[0].group, ids, axesById);
      if (yAxisId !== undefined) {
        const pointCount = maxSeriesLength(groupSeries);
        const columnSums: number[] = [];
        for (let i = 0; i < pointCount; i++) {
          let posSum = 0;
          let negSum = 0;
          for (const s of groupSeries) {
            const v = s.values[i];
            if (typeof v === "number" && Number.isFinite(v)) {
              if (v >= 0) {
                posSum += v;
              } else {
                negSum += v;
              }
            }
          }
          // Percent-stacked tops out at 1; column sums beyond that
          // are irrelevant because `buildSceneSeries` passes
          // `{min:0,max:1}` instead of consulting the axis range.
          if (isPercent) {
            columnSums.push(posSum === 0 ? 0 : 1, negSum === 0 ? 0 : -1);
          } else {
            columnSums.push(posSum, negSum);
          }
        }
        addAxisValues(yValuesByAxisId, yAxisId, columnSums);
      }
    }
  }
  const yRangesByAxisId = new Map<number, ValueRange>();
  for (const [axisId, values] of yValuesByAxisId) {
    yRangesByAxisId.set(axisId, getValueRange(values, axesById.get(axisId)));
  }
  const xRangesByAxisId = new Map<number, ValueRange>();
  for (const [axisId, values] of xValuesByAxisId) {
    xRangesByAxisId.set(
      axisId,
      getValueRange(values, axesById.get(axisId), { includeZero: false })
    );
  }
  return {
    axesById,
    primaryXAxis: pickAxis(axes, "x", false),
    primaryYAxis: pickAxis(axes, "y", false),
    // Secondary axes must be a DIFFERENT physical object from the
    // primary; otherwise `buildChartScene` emits `axes.x` and `axes.x2`
    // as two overlapping lines and `secondaryXLabels` duplicates
    // `xLabels` at the same position, double-drawing tick text. When
    // only one axis exists for a direction, treat secondary as absent.
    secondaryXAxis: pickSecondaryAxis(axes, "x", pickAxis(axes, "x", false)),
    secondaryYAxis: pickSecondaryAxis(axes, "y", pickAxis(axes, "y", false)),
    yRangesByAxisId,
    xRangesByAxisId,
    defaultYRange,
    defaultXRange
  };
}

function addAxisValues(map: Map<number, number[][]>, axisId: number, values: number[]): void {
  const existing = map.get(axisId);
  if (existing) {
    existing.push(values);
  } else {
    map.set(axisId, [values]);
  }
}

function pickAxis(
  axes: ChartAxis[],
  direction: "x" | "y",
  secondary: boolean
): ChartAxis | undefined {
  const positions = direction === "x" ? ["t", "b"] : ["r", "l"];
  const preferred = secondary ? positions[0] : positions[1];
  const fallback = secondary ? positions[1] : positions[0];
  return (
    axes.find(axis => !axis.delete && axis.axPos === preferred) ??
    (!secondary ? axes.find(axis => !axis.delete && axis.axPos === fallback) : undefined)
  );
}

/**
 * Pick a secondary axis that is distinct from the primary. When the
 * workbook only authored one axis in a given direction, `pickAxis(…,
 * secondary=true)` can return the same object the primary fallback
 * already picked (e.g. primary falls back to `t` when only `t` exists
 * → secondary also picks `t`). Exclude whatever the primary chose so
 * the caller never receives two references to the same axis.
 */
function pickSecondaryAxis(
  axes: ChartAxis[],
  direction: "x" | "y",
  primary: ChartAxis | undefined
): ChartAxis | undefined {
  const picked = pickAxis(axes, direction, true);
  return picked && picked !== primary ? picked : undefined;
}

function getSeriesYRange(series: NormalizedSeries, context: ChartAxisContext): ValueRange {
  const axisId = getYAxisIdForGroup(
    series.group,
    (series.group as { axisIds?: number[] }).axisIds ?? [],
    context.axesById
  );
  return axisId !== undefined
    ? (context.yRangesByAxisId.get(axisId) ?? context.defaultYRange)
    : context.defaultYRange;
}

function getSeriesXRange(series: NormalizedSeries, context: ChartAxisContext): ValueRange {
  const axisId = getXAxisIdForGroup(
    series.group,
    (series.group as { axisIds?: number[] }).axisIds ?? [],
    context.axesById
  );
  return axisId !== undefined
    ? (context.xRangesByAxisId.get(axisId) ?? context.defaultXRange)
    : context.defaultXRange;
}

function getGroupYRange(group: ChartTypeGroup, context: ChartAxisContext): ValueRange {
  const axisId = getYAxisIdForGroup(
    group,
    (group as { axisIds?: number[] }).axisIds ?? [],
    context.axesById
  );
  return axisId !== undefined
    ? (context.yRangesByAxisId.get(axisId) ?? context.defaultYRange)
    : context.defaultYRange;
}

function getYAxisIdForGroup(
  group: ChartTypeGroup,
  axisIds: number[],
  axesById: Map<number, ChartAxis>
): number | undefined {
  if (axisIds.length === 0) {
    return undefined;
  }
  if (isValueValueGroup(group)) {
    return (
      axisIds.find(id => axesById.get(id)?.axPos === "l" || axesById.get(id)?.axPos === "r") ??
      axisIds[1]
    );
  }
  return axisIds.find(id => axesById.get(id)?.axisType === "val") ?? axisIds[1];
}

function getXAxisIdForGroup(
  group: ChartTypeGroup,
  axisIds: number[],
  axesById: Map<number, ChartAxis>
): number | undefined {
  if (axisIds.length === 0) {
    return undefined;
  }
  if (isValueValueGroup(group)) {
    return (
      axisIds.find(id => axesById.get(id)?.axPos === "b" || axesById.get(id)?.axPos === "t") ??
      axisIds[0]
    );
  }
  return axisIds.find(id => axesById.get(id)?.axisType !== "val") ?? axisIds[0];
}

function isValueValueGroup(group: ChartTypeGroup): boolean {
  return group.type === "scatter" || group.type === "bubble";
}

/** True when this group type supports `grouping = "stacked" | "percentStacked"`. */
function isStackableGroup(group: ChartTypeGroup): boolean {
  return (
    group.type === "bar" ||
    group.type === "bar3D" ||
    group.type === "line" ||
    group.type === "line3D" ||
    group.type === "area" ||
    group.type === "area3D"
  );
}

function scatterXValues(series: NormalizedSeries): number[] {
  return series.xValues && series.xValues.length > 0
    ? series.xValues
    : series.values.map((_, i) => i + 1);
}

function buildSceneLegend(
  legend: ChartLegend | undefined,
  series: NormalizedSeries[],
  width: number,
  height: number,
  hasTitle: boolean,
  categories: string[] = []
): ChartSceneLegend {
  const visible = legend !== undefined && series.length > 0;
  const position = legend?.legendPos ?? "r";
  const orientation = position === "b" || position === "t" ? "horizontal" : "vertical";
  const deletedEntries = new Set(
    legend?.legendEntries?.filter(entry => entry.delete).map(entry => entry.index) ?? []
  );

  // When only 1 series but many categories, Excel shows per-category
  // legend entries (each category gets its own colour swatch). This is
  // the typical pivot-chart / varyColors pattern. Show ALL categories
  // (not just unique) to match Excel's behaviour.
  let items: Array<{ label: string; color: string }>;
  if (series.length === 1 && categories.length > 1) {
    items = categories.map((cat, i) => ({
      label: cat,
      color: COLORS[i % COLORS.length]
    }));
  } else {
    items = series
      .filter((_, index) => !deletedEntries.has(index))
      .map(s => ({
        label: s.label,
        color: s.color
      }));
  }

  const visibleLabels = items.map(item => item.label);
  const rect = legendRect(position, orientation, width, height, hasTitle, visibleLabels);
  const txStyle = textStyleFromTxPr(legend?.txPr);
  const txColor = legend?.txPr ? colorFromChartTextProperties(legend.txPr) : undefined;
  const textStyle =
    txStyle.fontFamily !== undefined ||
    txStyle.bold ||
    txStyle.italic ||
    txStyle.fontSize !== undefined ||
    txColor
      ? { ...txStyle, color: txColor }
      : undefined;
  return {
    rect,
    visible,
    position,
    orientation,
    items,
    textStyle
  };
}

function legendRect(
  position: LegendPosition,
  orientation: "horizontal" | "vertical",
  width: number,
  height: number,
  hasTitle: boolean,
  labels: string[]
): ChartSceneRect {
  // Each legend entry renders as a colour swatch + gap + label + inter-item
  // gap. Using real text metrics here (rather than a hardcoded pixel-per-item
  // value) lets longer series names push the legend wider instead of being
  // truncated by the viewport clipping region.
  const entryWidths = labels.map(
    label => LEGEND_SWATCH_WIDTH + estimateTextWidth(label, LEGEND_FONT_SIZE) + LEGEND_ENTRY_PADDING
  );
  if (orientation === "horizontal") {
    const totalEntries = entryWidths.reduce((sum, w) => sum + w, 0);
    const legendWidth = Math.min(
      width - LEGEND_HORIZ_INSET,
      Math.max(LEGEND_MIN_EXTENT, Math.ceil(totalEntries))
    );
    return {
      x: (width - legendWidth) / 2,
      y: position === "t" ? (hasTitle ? LEGEND_TOP_BELOW_TITLE : LEGEND_TOP_NO_TITLE) : height - 26,
      width: legendWidth,
      height: LEGEND_ROW_HEIGHT
    };
  }
  const longestLabelWidth = entryWidths.reduce((max, w) => (w > max ? w : max), 0);
  // Vertical legends stack entries vertically, so width is governed by the
  // widest label, not the total; ensure a sensible minimum so short names
  // don't produce an absurdly narrow legend column.
  const legendColumnWidth = Math.min(
    Math.max(LEGEND_MIN_EXTENT, Math.ceil(longestLabelWidth)),
    Math.max(LEGEND_MIN_EXTENT, width - 64)
  );
  const legendHeight = Math.min(
    height - LEGEND_VERT_INSET,
    Math.max(LEGEND_ROW_HEIGHT, labels.length * LEGEND_ROW_HEIGHT)
  );
  return {
    x: position === "l" ? LEGEND_OUTER_MARGIN : width - legendColumnWidth - LEGEND_OUTER_MARGIN,
    y:
      position === "tr"
        ? hasTitle
          ? LEGEND_TR_WITH_TITLE
          : LEGEND_TOP_NO_TITLE
        : Math.max(
            hasTitle ? PLOT_MARGIN_TOP_WITH_TITLE : PLOT_MARGIN_TOP_NO_TITLE,
            (height - legendHeight) / 2
          ),
    width: legendColumnWidth,
    height: legendHeight
  };
}

function buildAxisTitles(context: ChartAxisContext, plot: ChartSceneRect): ChartSceneText[] {
  const titles: ChartSceneText[] = [];
  addAxisTitle(titles, context.primaryXAxis, plot);
  addAxisTitle(titles, context.primaryYAxis, plot);
  addAxisTitle(titles, context.secondaryXAxis, plot);
  addAxisTitle(titles, context.secondaryYAxis, plot);
  return titles;
}

function addAxisTitle(
  titles: ChartSceneText[],
  axis: ChartAxis | undefined,
  plot: ChartSceneRect
): void {
  if (!axis || axis.delete || !axis.title) {
    return;
  }
  const text = titleToText(axis.title);
  if (!text) {
    return;
  }
  const base = {
    text,
    fontSize: 11,
    color: titleColor(axis.title),
    anchor: "middle" as const,
    ...textStyleFromTxPr(axis.title.txPr)
  };
  if (axis.axPos === "b") {
    titles.push({ ...base, x: plot.x + plot.width / 2, y: plot.y + plot.height + 38 });
  } else if (axis.axPos === "t") {
    titles.push({ ...base, x: plot.x + plot.width / 2, y: plot.y - 26 });
  } else if (axis.axPos === "l") {
    titles.push({ ...base, x: plot.x - 44, y: plot.y + plot.height / 2, rotate: -90 });
  } else if (axis.axPos === "r") {
    titles.push({ ...base, x: plot.x + plot.width + 44, y: plot.y + plot.height / 2, rotate: 90 });
  }
}

function categoriesForAxis(
  series: NormalizedSeries[],
  axis: ChartAxis | undefined,
  fallback: string[]
): string[] {
  if (!axis) {
    return fallback;
  }
  const matched = series.find(s => {
    const ids = (s.group as { axisIds?: number[] }).axisIds ?? [];
    return ids[0] === axis.axId;
  });
  return matched?.categories && matched.categories.length > 0 ? matched.categories : fallback;
}

function titleToText(title: ChartTitle): string | undefined {
  return (
    title.text?.paragraphs.map(p => (p.runs ?? []).map(r => r.text).join("")).join("\n") ??
    title.strRef?.cache?.points?.map(p => p.value).join("")
  );
}

function axisColor(axis: ChartAxis | undefined): string {
  return previewShapeLineColor(axis?.spPr ? getSpPrLine(axis.spPr) : undefined) ?? AXIS_COLOR;
}

function tickLabelColor(axis: ChartAxis | undefined): string {
  return colorFromChartTextProperties(axis?.txPr) ?? "#555555";
}

function titleColor(title: ChartTitle): string {
  return colorFromChartTextProperties(title.txPr) ?? "#333333";
}

function colorFromChartTextProperties(
  textProperties: ChartTextProperties | undefined
): string | undefined {
  if (!textProperties) {
    return undefined;
  }
  // Mirror `textStyleFromTxPr`: when the record arrived as raw XML
  // (`{ _rawXml: "..." }`) with no structured `color`, delegate to
  // `parseTxPr` so the authored colour is still recovered. Previously
  // this helper only read `.color.srgb` directly, which is `undefined`
  // on the raw-XML path — every Excel-loaded axis / title / legend
  // with a custom colour silently fell back to the caller's default.
  const resolved =
    typeof textProperties._rawXml === "string" && textProperties.color === undefined
      ? parseTxPr(textProperties)
      : textProperties;
  // Delegate to the shared ChartColor resolver so theme / sysClr /
  // prstClr are honoured on par with `srgbClr`. The previous
  // implementation read `color.srgb` only and silently reverted every
  // theme-coloured title / legend / axis / data-label text to the
  // caller's default grey.
  return resolveChartColor(resolved.color);
}

/**
 * Extract the font-related fields ({@link ChartSceneText}) from an
 * OOXML `txPr`-shaped record. Used to thread font family / bold /
 * italic from the chart model into the scene so SVG, PNG and PDF paths
 * all render with the authored typography. `color` / `fontSize` stay
 * at the call site — each text kind has its own default for those
 * (e.g. tick labels default to `#555555`, titles to `#333333`).
 *
 * Accepts both already-structured `ChartTextProperties` and the raw-XML
 * passthrough shape (`{ _rawXml: "..." }`) the xform/parser produces.
 * In the raw case we lazily invoke `parseTxPr` so consumers don't need
 * to pre-process loaded chart parts themselves.
 */
function textStyleFromTxPr(textProperties: ChartTextProperties | undefined): {
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
} {
  if (!textProperties) {
    return {};
  }
  // If the record arrived as raw XML (from a loaded chart part), decode
  // it once via the shape-properties parser. This mirrors how
  // `titleColor` already resolves colour from either form.
  const resolved =
    typeof textProperties._rawXml === "string" && textProperties.fontFamily === undefined
      ? parseTxPr(textProperties)
      : textProperties;
  const out: { fontFamily?: string; bold?: boolean; italic?: boolean; fontSize?: number } = {};
  if (typeof resolved.fontFamily === "string" && resolved.fontFamily.length > 0) {
    out.fontFamily = resolved.fontFamily;
  }
  if (resolved.bold) {
    out.bold = true;
  }
  if (resolved.italic) {
    out.italic = true;
  }
  // `txPr.size` is in hundredths of a point (OOXML convention); convert
  // to points. Ignore zero/NaN so callers keep their default fontSize.
  if (typeof resolved.size === "number" && Number.isFinite(resolved.size) && resolved.size > 0) {
    out.fontSize = resolved.size / 100;
  }
  return out;
}

function mergeDataLabels(group: ChartTypeGroup, series: SeriesBase): DataLabels | undefined {
  const groupLabels = (group as { dataLabels?: DataLabels }).dataLabels;
  const seriesLabels = (series as { dataLabels?: DataLabels }).dataLabels;
  return groupLabels || seriesLabels
    ? { ...(groupLabels ?? {}), ...(seriesLabels ?? {}) }
    : undefined;
}

function makeDataLabelText(
  labels: DataLabels,
  series: NormalizedSeries,
  category: string | undefined,
  value: number,
  total: number
): string {
  const sep = labels.separator ?? ", ";
  const parts: string[] = [];
  if (labels.showSerName) {
    parts.push(series.label);
  }
  if (labels.showCatName && category !== undefined) {
    parts.push(category);
  }
  if (labels.showVal) {
    parts.push(formatAxisNumber(value));
  }
  if (labels.showPercent) {
    // Use absolute magnitude for percentage labels — Excel's own
    // behaviour is `|v| / Σ|v|` so slices sum to 100 % even for a pie
    // / stacked chart containing negatives. The previous
    // `Math.max(0, value) / total` with `total = Σ max(0, v)` dropped
    // negatives entirely, producing slices whose visible percentages
    // summed to a number < 100 % (because each negative slice showed
    // as 0 %) or > 100 % (when the caller supplied a different total
    // convention).
    //
    // Guard against non-finite `value` (gaps propagated from
    // `collectNumberValues` as NaN) and `total === 0` — both would
    // emit a literal "NaN%" label that looks broken. Skip the
    // percentage component in those cases.
    if (Number.isFinite(value) && Number.isFinite(total) && total > 0) {
      parts.push(`${Math.round((Math.abs(value) / total) * 100)}%`);
    }
  }
  return parts.join(sep);
}

/**
 * Compute the sampled points of a trendline curve. Regression always
 * runs in raw data space (pre-log-transform) so the fitted curve
 * represents the author's original numbers. The returned points are
 * already mapped to pixel coordinates — the caller just hands them
 * to the SVG/PDF emitter.
 *
 * Supports Excel's full set of OOXML `<c:trendline>` types:
 *   - `linear`:   `y = a + b·x`
 *   - `exp`:      `y = a · e^(b·x)`  (linearised via `log(y) = log(a) + b·x`)
 *   - `log`:      `y = a + b · ln(x)`
 *   - `power`:    `y = a · x^b`      (linearised via `log(y) = log(a) + b·log(x)`)
 *   - `poly`:     `y = Σ c_i · x^i`  (least squares on Vandermonde matrix)
 *   - `movingAvg`: rolling mean over the last `period` points
 *
 * Categorical charts (line, bar, column, area, radar) use 1-based
 * category indexes as x; scatter and bubble charts use the authored
 * x values. This mirrors Excel — an author selecting "exponential
 * trendline" on a column chart gets `y = a · e^(b·i)` where `i` is
 * the 1-based point index.
 *
 * Previously linear regressed in pixel space. Because the SVG y axis
 * is inverted, the resulting "slope" carried the wrong sign for a
 * log-scale or reverse-orientation chart, and `exp`/`log`/`power`/
 * `poly` silently fell back to the same pixel-space linear fit.
 */
function computeTrendlinePoints(
  trendline: Trendline,
  _points: ChartScenePoint[],
  displayValues: number[],
  series: NormalizedSeries,
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartScenePoint[] {
  if (trendline.type === "movingAvg") {
    return movingAveragePoints(_points, displayValues, trendline.period ?? 2, plot, min, max);
  }

  // Build the fitter input in *raw* data space. Fall back to display
  // space only when raw data isn't available (should never happen
  // after `normalizeSeries`, but keep the path defensive).
  const rawValues = series.rawValues ?? displayValues;
  // Per-index lookup so the fitter aligns with whatever
  // `buildScatterPoints` / `buildBubbles` drew. The previous
  // all-or-nothing rule (use authored x if `rawXValues.length >=
  // rawValues.length`, else 1-based indices) meant a series whose
  // trailing `xRef` cells resolved to fewer points than the value
  // column silently switched the trendline to an integer x-domain
  // — the curve fit indices while the data points drew against the
  // authored x values. Mirror the scatter/bubble `xValues[i] ?? i + 1`
  // fallback instead so each sample stays aligned.
  const rawX = series.rawXValues ?? [];

  const samples: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < rawValues.length; i++) {
    const y = rawValues[i];
    // Per-sample fallback to 1-based indices when the authored x ref
    // didn't reach index `i`. Matches `buildScatterPoints` /
    // `buildBubbles` (`xValues[i] ?? i + 1`) so the fitted curve and
    // the plotted points live in the same x-domain.
    const x = rawX[i] ?? i + 1;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      samples.push({ x, y });
    }
  }
  if (samples.length < 2) {
    return [];
  }

  // Determine the x domain to sample the fitted curve over. Honor
  // `forward` / `backward` extensions (in raw x units) so users can
  // project a trend ahead/behind their data.
  let xLo = samples[0].x;
  let xHi = samples[samples.length - 1].x;
  for (const s of samples) {
    if (s.x < xLo) {
      xLo = s.x;
    }
    if (s.x > xHi) {
      xHi = s.x;
    }
  }
  if (!Number.isFinite(xLo) || !Number.isFinite(xHi) || xHi === xLo) {
    return [];
  }
  const forward = Number.isFinite(trendline.forward) ? (trendline.forward as number) : 0;
  const backward = Number.isFinite(trendline.backward) ? (trendline.backward as number) : 0;
  const domainLo = xLo - backward;
  const domainHi = xHi + forward;

  const evaluator = fitTrendlineEvaluator(trendline, samples);
  if (!evaluator) {
    return [];
  }

  // Linear trendlines render with just two endpoints — a straight
  // line in data space stays straight under the linear
  // category-axis / linear-value-axis mapping used for categorical
  // charts. Scatter charts with a log x-axis would bend the line,
  // so fall through to the sampled path when any transform is active.
  const needsSampling =
    trendline.type !== "linear" || series.yLogBase !== undefined || series.xLogBase !== undefined;
  const sampleCount = needsSampling ? 64 : 2;
  const result: ChartScenePoint[] = [];

  // For scatter / bubble charts, `points[i].x` is `valueToX(xValues[i],
  // xMin, xMax, plot)`. We reproduce the same mapping here so the
  // trendline endpoints line up with the drawn data. For line / bar
  // / column / area / radar charts, the x positions are
  // `plot.x + i * step` (see `buildLinePoints`), which is not a
  // `valueToX` call — instead we interpolate across the plot area
  // using the category index domain.
  const isValueX = series.group.type === "scatter" || series.group.type === "bubble";
  // Pre-compute pixel x range for the category axis so we don't have
  // to redo the (non-value) interpolation math per sample point.
  const catPointCount = rawValues.length;
  const pixelXForCat = (xData: number): number => {
    if (catPointCount <= 1) {
      return plot.x + plot.width / 2;
    }
    // Category indexes are 1-based in `rawX` but drawn at
    // `plot.x + i * step` with `step = plot.width / (n - 1)`.
    // Convert back: index `k` (0-based) → `plot.x + k * step`.
    const step = plot.width / (catPointCount - 1);
    const clamped = Math.max(0, Math.min(catPointCount - 1, xData - 1));
    return plot.x + clamped * step;
  };
  const valueXContext = isValueX ? resolveScatterXContext(series, catPointCount) : undefined;

  for (let i = 0; i < sampleCount; i++) {
    // `sampleCount` is either 2 (linear endpoints) or 64 (curve
    // sampling), so `sampleCount - 1` is never zero — but guard
    // defensively so future changes to the constant can't divide by
    // zero and poison every sample's t.
    const divisor = sampleCount > 1 ? sampleCount - 1 : 1;
    const t = i / divisor;
    const xData = domainLo + (domainHi - domainLo) * t;
    const yData = evaluator(xData);
    if (!Number.isFinite(yData)) {
      continue;
    }
    // Re-apply the y-axis log transform (if any) so the plotted
    // curve lands at the correct pixel y on a log-scale chart.
    const yDisplay = series.yLogBase ? applyAxisTransform(yData, series.yLogBase) : yData;
    if (!Number.isFinite(yDisplay)) {
      continue;
    }
    let px: number;
    if (isValueX && valueXContext) {
      const xDisplay = series.xLogBase ? applyAxisTransform(xData, series.xLogBase) : xData;
      if (!Number.isFinite(xDisplay)) {
        continue;
      }
      px = valueToX(xDisplay, valueXContext.min, valueXContext.max, plot);
    } else {
      px = pixelXForCat(xData);
    }
    const py = valueToY(yDisplay, min, max, plot);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      result.push({ x: px, y: py });
    }
  }
  return result;
}

/**
 * Return a function `f(x) -> y` that evaluates the fitted trendline
 * curve in raw data space. Returns `undefined` when the fit can't be
 * computed for this sample set (e.g. exponential/power require strictly
 * positive y values; log requires strictly positive x values; poly
 * needs enough points to pin down the order).
 */
function fitTrendlineEvaluator(
  trendline: Trendline,
  samples: Array<{ x: number; y: number }>
): ((x: number) => number) | undefined {
  switch (trendline.type) {
    case "linear": {
      const { slope, intercept } = linearLeastSquares(
        samples.map(s => s.x),
        samples.map(s => s.y)
      );
      if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
        return undefined;
      }
      return x => slope * x + intercept;
    }
    case "exp": {
      // Fit log(y) = log(a) + b·x, requires y > 0.
      const filtered = samples.filter(s => s.y > 0);
      if (filtered.length < 2) {
        return undefined;
      }
      const { slope: b, intercept: lnA } = linearLeastSquares(
        filtered.map(s => s.x),
        filtered.map(s => Math.log(s.y))
      );
      if (!Number.isFinite(b) || !Number.isFinite(lnA)) {
        return undefined;
      }
      const a = Math.exp(lnA);
      return x => a * Math.exp(b * x);
    }
    case "log": {
      // Fit y = a + b·ln(x), requires x > 0.
      const filtered = samples.filter(s => s.x > 0);
      if (filtered.length < 2) {
        return undefined;
      }
      const { slope: b, intercept: a } = linearLeastSquares(
        filtered.map(s => Math.log(s.x)),
        filtered.map(s => s.y)
      );
      if (!Number.isFinite(b) || !Number.isFinite(a)) {
        return undefined;
      }
      return x => (x > 0 ? a + b * Math.log(x) : NaN);
    }
    case "power": {
      // Fit log(y) = log(a) + b·log(x), requires x > 0 and y > 0.
      const filtered = samples.filter(s => s.x > 0 && s.y > 0);
      if (filtered.length < 2) {
        return undefined;
      }
      const { slope: b, intercept: lnA } = linearLeastSquares(
        filtered.map(s => Math.log(s.x)),
        filtered.map(s => Math.log(s.y))
      );
      if (!Number.isFinite(b) || !Number.isFinite(lnA)) {
        return undefined;
      }
      const a = Math.exp(lnA);
      return x => (x > 0 ? a * Math.pow(x, b) : NaN);
    }
    case "poly": {
      // Default to order 2 when the user didn't pin one down. Clamp
      // to Excel's accepted range [2, 6] to match the builder-side
      // `validateTrendlineOptions`; higher orders are numerically
      // unstable on small samples.
      const orderRaw = trendline.order ?? 2;
      const order = Math.max(2, Math.min(6, Math.floor(orderRaw)));
      if (samples.length <= order) {
        // Not enough points to fit — fall back to linear rather than
        // return no trend at all, mirroring Excel's behaviour of
        // showing a degenerate line when a high-order poly lacks data.
        const { slope, intercept } = linearLeastSquares(
          samples.map(s => s.x),
          samples.map(s => s.y)
        );
        if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
          return undefined;
        }
        return x => slope * x + intercept;
      }
      const coeffs = polynomialLeastSquares(
        samples.map(s => s.x),
        samples.map(s => s.y),
        order
      );
      if (!coeffs || coeffs.some(c => !Number.isFinite(c))) {
        return undefined;
      }
      return x => {
        let acc = 0;
        let pow = 1;
        for (const c of coeffs) {
          acc += c * pow;
          pow *= x;
        }
        return acc;
      };
    }
    default: {
      // `movingAvg` is handled in the caller; any other type is an
      // invariant violation (the `TrendlineType` enum would have had
      // to gain a new variant without this switch).
      return undefined;
    }
  }
}

/**
 * Ordinary least-squares linear regression. Returns NaN slope /
 * intercept when the input is degenerate (single unique x, or all
 * non-finite); the caller filters finite inputs upstream.
 */
function linearLeastSquares(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { slope: NaN, intercept: NaN };
  }
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= n;
  meanY /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) {
    return { slope: NaN, intercept: NaN };
  }
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Least-squares polynomial fit of degree `order`. Solves the normal
 * equations `(V^T · V) · c = V^T · y` via Gaussian elimination. The
 * Vandermonde matrix `V[i][j] = xs[i]^j` is built in-place; for the
 * orders Excel accepts (2–6) the system is small enough that LU
 * factorisation isn't worth the extra complexity.
 *
 * Returns the coefficients in ascending-power order: `[c0, c1, …, cN]`
 * so `y = c0 + c1·x + c2·x^2 + …`. Returns `undefined` if the system
 * is singular (rank-deficient input — e.g. all identical x values).
 */
function polynomialLeastSquares(xs: number[], ys: number[], order: number): number[] | undefined {
  const n = Math.min(xs.length, ys.length);
  const m = order + 1;
  if (n < m) {
    return undefined;
  }
  // Normalise x to reduce conditioning issues on large-magnitude
  // inputs (e.g. year numbers): subtract the mean, rescale by the
  // range. We undo the transform below when returning coefficients.
  let meanX = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i];
  }
  meanX /= n;
  let rangeX = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(xs[i] - meanX);
    if (d > rangeX) {
      rangeX = d;
    }
  }
  const scale = rangeX > 0 ? rangeX : 1;
  const sx = xs.map(x => (x - meanX) / scale);

  // Build normal equations.
  const ata: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const atb: number[] = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i++) {
    const x = sx[i];
    const powers = new Array<number>(m);
    let p = 1;
    for (let j = 0; j < m; j++) {
      powers[j] = p;
      p *= x;
    }
    const y = ys[i];
    for (let j = 0; j < m; j++) {
      atb[j] += powers[j] * y;
      for (let k = 0; k < m; k++) {
        ata[j][k] += powers[j] * powers[k];
      }
    }
  }

  // Solve via Gaussian elimination with partial pivoting.
  const aug = ata.map((row, i) => [...row, atb[i]]);
  for (let col = 0; col < m; col++) {
    let pivot = col;
    let pivotAbs = Math.abs(aug[pivot][col]);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(aug[r][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = r;
      }
    }
    if (pivotAbs < 1e-12) {
      return undefined;
    }
    if (pivot !== col) {
      const tmp = aug[col];
      aug[col] = aug[pivot];
      aug[pivot] = tmp;
    }
    const pivotVal = aug[col][col];
    for (let c = col; c <= m; c++) {
      aug[col][c] /= pivotVal;
    }
    for (let r = 0; r < m; r++) {
      if (r === col) {
        continue;
      }
      const factor = aug[r][col];
      if (factor === 0) {
        continue;
      }
      for (let c = col; c <= m; c++) {
        aug[r][c] -= factor * aug[col][c];
      }
    }
  }
  const scaled = new Array<number>(m);
  for (let j = 0; j < m; j++) {
    scaled[j] = aug[j][m];
  }

  // Undo the `(x - meanX) / scale` substitution:
  //   y = Σ scaled[j] · ((x - meanX) / scale)^j
  // Expand via binomial theorem into coefficients in `x`.
  const result = new Array<number>(m).fill(0);
  for (let j = 0; j < m; j++) {
    const sj = scaled[j] / Math.pow(scale, j);
    // (x - meanX)^j = Σ_{k=0..j} C(j,k) · x^k · (-meanX)^(j-k)
    for (let k = 0; k <= j; k++) {
      result[k] += sj * binomial(j, k) * Math.pow(-meanX, j - k);
    }
  }
  return result;
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  if (k === 0 || k === n) {
    return 1;
  }
  let num = 1;
  let den = 1;
  const limit = Math.min(k, n - k);
  for (let i = 0; i < limit; i++) {
    num *= n - i;
    den *= i + 1;
  }
  return num / den;
}

/**
 * Recover the x-axis data-space `min`/`max` used to position the
 * scatter/bubble points so the trendline curve lines up pixel-
 * perfect with the plotted data. Mirrors the computation inside
 * `buildScatterPoints` / `buildBubbles` — kept in sync by going
 * through the same `xValues.reduce` walk and falling back to
 * `[0, n]` when no x series is authored.
 */
function resolveScatterXContext(
  series: NormalizedSeries,
  pointCount: number
): { min: number; max: number } | undefined {
  const xValues = series.xValues && series.xValues.length > 0 ? series.xValues : undefined;
  if (!xValues) {
    return { min: 0, max: Math.max(1, pointCount) };
  }
  // Seed with ±Infinity so the fold converges on the true extremes.
  // Previously `min=0, max=1` anchored the range for any x-series whose
  // values never crossed those thresholds — e.g. `x=[10,20,30]` produced
  // `{min: 0, max: 30}` even though the data starts at 10. The scatter
  // geometry elsewhere uses `getSeriesXRange(..., includeZero:false)`
  // which *does* converge on `{min:10, max:30}`, so the trendline drew
  // with one x-domain while the data points drew with another.
  let min = Infinity;
  let max = -Infinity;
  for (const x of xValues) {
    if (!Number.isFinite(x)) {
      continue;
    }
    if (x < min) {
      min = x;
    }
    if (x > max) {
      max = x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: Math.max(1, pointCount) };
  }
  if (max <= min) {
    max = min + 1;
  }
  return { min, max };
}

function movingAveragePoints(
  points: ChartScenePoint[],
  values: number[],
  period: number,
  plot: ChartSceneRect,
  min: number,
  max: number
): ChartScenePoint[] {
  const safePeriod = Math.max(1, Math.floor(period));
  return points.map((point, i) => {
    const start = Math.max(0, i - safePeriod + 1);
    // Filter gap markers (`NaN` from `collectNumberValues`) out of the
    // moving-average window. Without the filter a single blank cell
    // anywhere in the source range poisoned the mean (`NaN + x = NaN`)
    // and the trendline jumped to the plot midpoint (`valueToY(NaN)`)
    // for every point after the gap, producing a visible "dead zone"
    // that never recovered.
    const window = values.slice(start, i + 1).filter(v => Number.isFinite(v));
    if (window.length === 0) {
      return { x: point.x, y: point.y };
    }
    const avg = window.reduce((sum, v) => sum + v, 0) / window.length;
    return { x: point.x, y: valueToY(avg, min, max, plot) };
  });
}

/**
 * Compute the plus and minus offsets for a single error-bar data point.
 * Returns a `{ plus, minus }` pair so custom (`c:errValType="cust"`)
 * error bars can honour their authored per-point `plus` / `minus`
 * arrays — previously the generic `errorAmount` returned a single
 * magnitude and custom bars silently fell back to `err.val ?? 1`,
 * ignoring the worksheet-driven values entirely.
 */
function errorAmounts(
  err: ErrorBars,
  value: number,
  values: number[],
  pointIndex: number
): { plus: number; minus: number } {
  if (err.errValType === "fixedVal") {
    const v = err.val ?? 1;
    return { plus: v, minus: v };
  }
  if (err.errValType === "percentage") {
    const v = Math.abs(value) * ((err.val ?? 5) / 100);
    return { plus: v, minus: v };
  }
  if (err.errValType === "cust") {
    // Per-point arrays. Missing entries fall back to 0 (no bar in that
    // direction) rather than `err.val ?? 1` — Excel leaves the bar
    // stub absent when the referenced cell is blank.
    const plusPoints = err.plus?.numRef?.cache?.points ?? err.plus?.numLit?.points ?? [];
    const minusPoints = err.minus?.numRef?.cache?.points ?? err.minus?.numLit?.points ?? [];
    const findAt = (points: typeof plusPoints): number => {
      const match = points.find(p => p.index === pointIndex);
      const raw = match?.value;
      return typeof raw === "number" && Number.isFinite(raw) ? Math.abs(raw) : 0;
    };
    return { plus: findAt(plusPoints), minus: findAt(minusPoints) };
  }
  if (err.errValType === "stdDev" || err.errValType === "stdErr") {
    // Filter to finite values so "gap" points (`NaN` via
    // `collectNumberValues`) don't poison the mean / variance. Without
    // the filter a single blank cell in the series propagated `NaN`
    // all the way to `errorAmount`, which `buildErrorBars` then fed
    // into `valueToY` and produced invalid `<line y1="NaN" …/>`
    // attributes.
    const finite = values.filter(v => Number.isFinite(v));
    if (finite.length === 0) {
      const v = err.val ?? 1;
      return { plus: v, minus: v };
    }
    const n = finite.length;
    const mean = finite.reduce((sum, v) => sum + v, 0) / n;
    // Excel's "Standard Deviation" error bars compute the *sample*
    // standard deviation via `STDEV.S` = `sqrt(Σ(x-μ)² / (n-1))`; the
    // previous implementation divided by `n`, producing systematically
    // narrower bars than Excel for any series with fewer than ~100
    // points (the classic finite-sample bias). Guard against `n == 1`
    // by dividing by `max(1, n-1)` — a single-point sample has
    // undefined variance; Excel displays no error bar in that case,
    // but falling back to the point's own magnitude keeps the
    // rendered output non-zero without reintroducing the population
    // variance bug.
    const divisor = Math.max(1, n - 1);
    const variance = finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / divisor;
    const stdDev = Math.sqrt(variance);
    // Standard error of the mean = sample stdev / sqrt(n).
    const magnitude = err.errValType === "stdDev" ? stdDev * (err.val ?? 1) : stdDev / Math.sqrt(n);
    return { plus: magnitude, minus: magnitude };
  }
  const fallback = err.val ?? 1;
  return { plus: fallback, minus: fallback };
}

function getValueRange(
  seriesValues: number[][],
  axis?: ChartAxis,
  options: { includeZero?: boolean; padding?: number } = {}
): ValueRange {
  const values = seriesValues.flat().filter(Number.isFinite);
  const includeZero = options.includeZero !== false;
  // Use `reduce` instead of `Math.min(...arr)` / `Math.max(...arr)` — the
  // spread-based call allocates each element as an argument and blows the
  // JS stack once `arr.length` exceeds ~100k, which happens in real-world
  // datasets (minute-granularity telemetry, etc.).
  //
  // Seed `rawMin` / `rawMax` symmetrically so both folds converge on the
  // true extremes. `includeZero=true` anchors the range at 0 (Excel's
  // default "axis crosses at value 0" behaviour for bar / column charts);
  // `includeZero=false` uses unbounded seeds so scatter / bubble charts
  // can hug their data.
  //
  // Previously `rawMax` was seeded with the literal `1`, so all-negative
  // data (`[-100, -50]`) ended up with `max=1` (a bogus tick at the top
  // of the axis), and fractional scatter data (`[0.1, 0.3, 0.5]` with
  // `includeZero:false`) got `max=1` instead of `0.5` — the x-axis
  // extended well past the real data.
  const baseMin = includeZero ? 0 : Infinity;
  const baseMax = includeZero ? 0 : -Infinity;
  const rawMin = values.length > 0 ? values.reduce((acc, v) => (v < acc ? v : acc), baseMin) : 0;
  const rawMax = values.length > 0 ? values.reduce((acc, v) => (v > acc ? v : acc), baseMax) : 1;
  // When the axis is logarithmic, `seriesValues` has already been
  // pre-transformed by `normalizeSeries` through `applyAxisTransform`
  // — so `rawMin` / `rawMax` are in LOG space. The author-supplied
  // `scaling.min` / `scaling.max` (OOXML `c:min/@val`, `c:max/@val`),
  // however, are RAW data values. Mixing them places every point at
  // the extreme end of the axis.
  //
  // Example: log10 axis, `scaling.min=1`, `scaling.max=10000`, data
  // `[10, 100, 1000]`. Pre-transformed values are `[1, 2, 3]`;
  // `getValueRange` must compare them against log10(1)=0 and
  // log10(10000)=4, not raw 1 and 10000.
  const logBase = axis?.scaling?.logBase;
  const toAxisSpace = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : applyAxisTransform(v, logBase);
  const min = toAxisSpace(axis?.scaling?.min) ?? rawMin;
  const max = toAxisSpace(axis?.scaling?.max) ?? rawMax;
  // Widen when max <= min so downstream `valueToY` has a non-zero span
  // to divide by.
  const base: ValueRange = max <= min ? { min, max: min + 1 } : { min, max };
  // Apply symmetric padding (e.g. 5% each side) so scatter/bubble edge
  // points don't land exactly on the plot boundary.
  const pad = options.padding ?? 0;
  if (pad > 0 && !axis?.scaling?.min && !axis?.scaling?.max) {
    const span = base.max - base.min;
    base.min -= span * pad;
    base.max += span * pad;
  }
  // `scaling.orientation === "maxMin"` reverses the axis — low values
  // render at the top-right instead of the bottom-left. The renderer's
  // `valueToY` / `valueToX` helpers compute position from the passed-in
  // `(min, max)`, so swapping them flips the axis direction without
  // every call site needing to know about orientation. This honours
  // Excel's "values in reverse order" axis option.
  if (axis?.scaling?.orientation === "maxMin") {
    return { min: base.max, max: base.min };
  }
  return base;
}

/**
 * Apply a logarithmic axis transform when the given axis is configured
 * with `scaling.logBase`. Caller uses the transformed value / min / max
 * with the plain {@link valueToY} / {@link valueToX} helpers so the
 * rest of the renderer does not need to know about the log scale.
 *
 * Returns the input unchanged when `logBase` is absent / invalid or
 * when the value is non-positive (log scales can't plot ≤0 values; we
 * fall back to the raw value rather than `-Infinity` so the point
 * still shows up somewhere near the bottom).
 */
export function applyAxisTransform(value: number, logBase: number | undefined): number {
  if (!logBase || logBase <= 0 || logBase === 1) {
    return value;
  }
  if (!Number.isFinite(value) || value <= 0) {
    // OOXML: "Values less than or equal to 0 are not allowed on
    // logarithmic axes." We can't refuse to render, so anchor them at
    // the axis minimum by returning a sentinel the caller may clamp
    // later. For now, skip the transform — the caller sees the raw
    // value and the renderer places it at the axis bottom.
    return value;
  }
  return Math.log(value) / Math.log(logBase);
}

/**
 * Generate SVG `<filter>` definitions for any series in `normalized`
 * that carries an `a:effectLst`, and thread the filter id onto the
 * matching `sceneSeries` entry so the renderer can reference it.
 *
 * Effect lists with identical structure share a single filter
 * definition (cache keyed by JSON stringify) so a chart with five
 * series all using the same drop shadow emits only one `<filter>`.
 *
 * Mutates `sceneSeries[i].effectFilterId` in place and returns the
 * list of unique filter definitions. Safe to call on a scene that
 * has no effect lists — returns an empty array in that case.
 */
function assignEffectFilters(
  normalized: NormalizedSeries[],
  sceneSeries: ChartSceneSeries[]
): ChartSceneEffectFilter[] {
  const filters: ChartSceneEffectFilter[] = [];
  const keyToId = new Map<string, string>();
  const limit = Math.min(normalized.length, sceneSeries.length);
  for (let i = 0; i < limit; i++) {
    const rawSpPr = (normalized[i].series as { spPr?: ShapeProperties }).spPr;
    if (!rawSpPr) {
      continue;
    }
    // Loaded charts hold spPr as `{ _rawXml: "…" }` without structured
    // `effectList`; run parse-on-demand so DrawingML shadow / glow /
    // reflection / blur / inner-shadow effects survive from the
    // round-trip path to the preview. Previously this helper read
    // `spPr.effectList` directly, which was always `undefined` for
    // Excel-authored charts and silently dropped every effect filter.
    const structured = getSpPrEffectList(rawSpPr);
    if (!structured) {
      continue;
    }
    // Stable cache key so duplicate effect trees share a filter. We
    // intentionally ignore field ordering differences — JSON stringify
    // is deterministic for the flat record shape `EffectList` uses.
    const key = JSON.stringify(structured);
    let id = keyToId.get(key);
    if (!id) {
      const xml = buildEffectFilter(`documonster-fx-${filters.length + 1}`, structured);
      if (!xml) {
        continue;
      }
      id = `documonster-fx-${filters.length + 1}`;
      keyToId.set(key, id);
      filters.push({ id, xml });
    }
    (sceneSeries[i] as ChartSceneAdornment).effectFilterId = id;
  }
  return filters;
}

/**
 * Extract a structured {@link EffectList} from a `ShapeProperties`
 * object that may still carry its raw-XML payload. The write-side
 * `parseSpPr` handles both code paths; surfaces this helper here so
 * `assignEffectFilters` stays focused on cache-key / id assignment.
 */
function getSpPrEffectList(spPr: ShapeProperties): EffectList | undefined {
  if (spPr.effectList) {
    return spPr.effectList;
  }
  if (typeof spPr._rawXml === "string") {
    return parseSpPr(spPr).effectList;
  }
  return undefined;
}

/**
 * Translate a DrawingML {@link EffectList} into an SVG `<filter>`
 * element. The translation is lossy — SVG filters don't express every
 * Excel effect pixel-for-pixel — but they do capture the four effects
 * that cover the overwhelming majority of real-world usage:
 *
 *   - `outerShadow` / `presetShadow` → `<feGaussianBlur>` +
 *     `<feOffset>` + `<feMerge>` (Excel's outer-shadow dist/dir/blur
 *     maps directly onto SVG's offset + blur-stdDeviation).
 *   - `innerShadow`                  → `<feComposite operator="arithmetic">`
 *     carving a shadow inside the shape.
 *   - `glow`                         → blurred coloured duplicate
 *     under the source.
 *   - `blur`                         → a single `<feGaussianBlur>`.
 *   - `softEdge`                     → a `<feGaussianBlur>` feeding
 *     into the source alpha.
 *
 * Reflection is modelled as a semi-transparent y-flipped duplicate;
 * Excel's actual implementation uses a much more complicated
 * gradient-masked clone. The preview is recognisable as a reflection
 * but does not match Excel pixel-for-pixel.
 *
 * Callers are expected to embed the returned string inside an SVG
 * `<defs>` block and reference it via `filter="url(#<id>)"` on the
 * shapes they want to affect. Returns `""` when the effect list is
 * empty — callers can skip emission entirely.
 */
export function buildEffectFilter(id: string, effects: EffectList | undefined): string {
  if (!effects) {
    return "";
  }
  const prims: string[] = [];
  let inLayer = "SourceGraphic";

  if (effects.blur) {
    prims.push(
      `<feGaussianBlur in="${inLayer}" stdDeviation="${emuToPx(effects.blur.radius ?? 0)}" result="blur0"/>`
    );
    inLayer = "blur0";
  }

  if (effects.softEdge) {
    const sd = emuToPx(effects.softEdge.radius);
    prims.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${sd}" result="softAlpha"/>`,
      `<feComposite in="${inLayer}" in2="softAlpha" operator="in" result="soft"/>`
    );
    inLayer = "soft";
  }

  const shadow = effects.outerShadow ?? effects.presetShadow;
  if (shadow) {
    // `presetShadow` lacks `blurRadius`; fall back to a gentle default.
    const blur = emuToPx((shadow as { blurRadius?: number }).blurRadius ?? 38100);
    const [dx, dy] = polarOffset(shadow.distance ?? 0, shadow.direction ?? 0);
    const colour = colourToHex(shadow.color) ?? "#000000";
    const alpha = alphaFromColor(shadow.color);
    prims.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur}" result="shadowBlur"/>`,
      `<feOffset in="shadowBlur" dx="${dx}" dy="${dy}" result="shadowOffset"/>`,
      `<feFlood flood-color="${colour}" flood-opacity="${alpha}" result="shadowColour"/>`,
      `<feComposite in="shadowColour" in2="shadowOffset" operator="in" result="shadowOut"/>`,
      `<feMerge result="shadowMerged"><feMergeNode in="shadowOut"/><feMergeNode in="${inLayer}"/></feMerge>`
    );
    inLayer = "shadowMerged";
  }

  if (effects.glow) {
    const blur = emuToPx(effects.glow.radius);
    const colour = colourToHex(effects.glow.color) ?? "#ffff66";
    prims.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur}" result="glowBlur"/>`,
      `<feFlood flood-color="${colour}" result="glowColour"/>`,
      `<feComposite in="glowColour" in2="glowBlur" operator="in" result="glowOut"/>`,
      `<feMerge result="glowMerged"><feMergeNode in="glowOut"/><feMergeNode in="${inLayer}"/></feMerge>`
    );
    inLayer = "glowMerged";
  }

  if (effects.innerShadow) {
    const blur = emuToPx(effects.innerShadow.blurRadius ?? 0);
    const [dx, dy] = polarOffset(
      effects.innerShadow.distance ?? 0,
      effects.innerShadow.direction ?? 0
    );
    const colour = colourToHex(effects.innerShadow.color) ?? "#000000";
    const alpha = alphaFromColor(effects.innerShadow.color);
    prims.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur}" result="innerBlur"/>`,
      `<feOffset in="innerBlur" dx="${dx}" dy="${dy}" result="innerOffset"/>`,
      `<feComposite in="SourceAlpha" in2="innerOffset" operator="out" result="innerClipped"/>`,
      `<feFlood flood-color="${colour}" flood-opacity="${alpha}" result="innerColour"/>`,
      `<feComposite in="innerColour" in2="innerClipped" operator="in" result="innerOut"/>`,
      `<feMerge result="innerMerged"><feMergeNode in="${inLayer}"/><feMergeNode in="innerOut"/></feMerge>`
    );
  }

  if (prims.length === 0) {
    return "";
  }
  // Filter region is widened past the shape bounds so blurred shadows
  // don't clip at the element edges. SVG's default is -10%..-10%..120%..120%
  // which already covers most of what we need, but Excel effects can
  // be dramatic.
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" filterUnits="objectBoundingBox">${prims.join(
    ""
  )}</filter>`;
}

/** Convert an Excel EMU distance to approximate SVG px (12700 EMU ≈ 1 pt ≈ 1.333 px). */
function emuToPx(emu: number): number {
  return emu / 12700;
}

/**
 * Decompose Excel's polar shadow (`dist` in EMU, `dir` in 1/60000°)
 * into SVG-native (dx, dy) offsets in px.
 */
function polarOffset(distanceEmu: number, direction1_60000: number): [number, number] {
  const dist = emuToPx(distanceEmu);
  const rad = (direction1_60000 / 60000) * (Math.PI / 180);
  return [dist * Math.cos(rad), dist * Math.sin(rad)];
}

function colourToHex(color: ChartColor | undefined): string | undefined {
  // Delegate every DrawingML colour variant to the shared
  // `resolveChartColor` helper — previously this function only
  // honoured `srgbClr` and silently dropped theme / preset / sysClr
  // shadow / glow / effect colours to the caller's fallback. The
  // 8-digit → 6-digit RGB normalisation (DrawingML stores alpha
  // separately via `<a:alpha>`; CSS 8-digit `#RRGGBBAA` is a
  // downstream extension we do not round-trip as a fill colour)
  // moves into the resolver's srgb branch via `normalizeHex6`.
  const resolved = resolveChartColor(color);
  if (!resolved) {
    return undefined;
  }
  const normalised = normalizeHex6(resolved);
  return normalised ? `#${normalised}` : resolved;
}

function alphaFromColor(color: ChartColor | undefined): number {
  if (!color || color.alpha === undefined) {
    return 1;
  }
  // Excel alpha is 0..100000 where 100000 == fully opaque.
  return Math.max(0, Math.min(1, color.alpha / 100000));
}

function applyLineStyle(line: ChartSceneLine, axis: ChartAxis | undefined): ChartSceneLine {
  return {
    ...line,
    color: axisColor(axis),
    width: previewShapeLineWidthPx(axis?.spPr ? getSpPrLine(axis.spPr) : undefined) ?? line.width
  };
}

function renderSvgSeries(parts: string[], series: ChartSceneSeries): void {
  // When the series carries an `a:effectLst`, wrap its primary shapes
  // in a `<g filter="url(#...)">` so the DrawingML effect (shadow /
  // glow / reflection / soft-edge / blur / inner-shadow) applies
  // uniformly. Adornments (labels, markers, trendlines, error bars)
  // intentionally render outside the group so they don't inherit the
  // filter — matching Excel's convention where markers are drawn
  // sharp over a blurred series.
  const filterId = (series as ChartSceneAdornment).effectFilterId;
  if (filterId) {
    parts.push(`<g filter="url(#${filterId})">`);
  }
  if (series.type === "bar") {
    for (const bar of series.bars) {
      if (series.depth && series.projection3D) {
        // Proper extruded box: top face + front face + right face with
        // shading so the user can read the axonometric projection. The
        // back face is hidden behind the front rect by definition, so
        // we only paint three visible faces.
        parts.push(renderBar3DBox(bar, series.projection3D, series.color, series.horizontal));
      } else {
        // Plain 2D bar. `buildSceneSeries` sets `depth` to 0 whenever
        // `projection3D` is undefined (see the `bar3DDepth` ternary),
        // so the `depth && !projection3D` case is structurally
        // unreachable and the old `renderBarDepth` extrusion-only
        // fallback has been removed.
        parts.push(
          `<rect x="${fmt(bar.x)}" y="${fmt(bar.y)}" width="${fmt(bar.width)}" height="${fmt(bar.height)}" fill="${series.color}"/>`
        );
      }
    }
  } else if (series.type === "area") {
    // Split the upper / lower line at NaN gaps so a missing data point
    // doesn't produce a stray `(x, 0)` spike across the area outline.
    const segments = segmentFinitePoints(series.points);
    const lowerSource =
      series.lowerPoints ?? series.points.map(p => ({ x: p.x, y: series.baselineY }));
    for (const segment of segments) {
      if (segment.length < 2) {
        continue;
      }
      // Build the matching lower slice with the same x-range so the
      // stacked-area fill stays closed across any gaps above.
      const startX = segment[0].x;
      const endX = segment[segment.length - 1].x;
      const lowerSegment = lowerSource.filter(p => p.x >= startX && p.x <= endX);
      if (lowerSegment.length === 0) {
        continue;
      }
      const polygonPoints = [...segment, ...lowerSegment.slice().reverse()];
      parts.push(
        `<polygon points="${polygonPoints.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}" fill="${withAlpha(series.color, 0.35)}"/>`
      );
      parts.push(
        `<polyline points="${segment.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}" fill="none" stroke="${series.color}" stroke-width="2"/>`
      );
    }
  } else if (series.type === "line" || series.type === "scatter") {
    if (series.showLine !== false) {
      // Honour the `dispBlanksAs="gap"` default: split the polyline at
      // non-finite points so a blank cell in the source range renders
      // as an actual break in the line, not a dip to `(x, 0)` (the
      // previous output of `fmt(NaN) === "0"`). Scatter plots already
      // expect gaps between unrelated points.
      const segments = segmentFinitePoints(series.points);
      const strokeAttrs = series.smooth ? ' stroke-linejoin="round" stroke-linecap="round"' : "";
      for (const segment of segments) {
        if (segment.length < 2) {
          continue;
        }
        parts.push(
          `<polyline points="${segment.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}" fill="none" stroke="${series.color}" stroke-width="2"${strokeAttrs}/>`
        );
      }
    }
    for (const point of series.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        continue;
      }
      parts.push(
        `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="3" fill="${series.color}"/>`
      );
    }
  } else if (series.type === "bubble") {
    for (const bubble of series.bubbles) {
      parts.push(
        `<circle cx="${fmt(bubble.x)}" cy="${fmt(bubble.y)}" r="${fmt(bubble.radius)}" fill="${withAlpha(series.color, 0.55)}" stroke="${series.color}"/>`
      );
    }
  } else if (series.type === "pie" || series.type === "doughnut") {
    for (const slice of series.slices) {
      parts.push(renderSvgPieSlice(slice));
    }
  } else if (series.type === "ofPie") {
    for (const slice of series.slices) {
      parts.push(renderSvgPieSlice(slice));
    }
    for (const line of series.connectors ?? []) {
      parts.push(renderSvgLine(line));
    }
    for (const slice of series.secondarySlices ?? []) {
      parts.push(renderSvgPieSlice(slice));
    }
  } else if (series.type === "radar") {
    // Split at non-finite vertices (NaN markers for blank / `#N/A`
    // values) so the polygon/polyline doesn't plunge through the plot
    // centre at each gap. Matches line/area gap handling; see
    // `segmentFinitePoints`.
    parts.push(
      `<circle cx="${fmt(series.center.x)}" cy="${fmt(series.center.y)}" r="${fmt(series.radius)}" fill="none" stroke="${GRID_COLOR}"/>`
    );
    const segments = segmentFinitePoints(series.points);
    // A fully-finite series is still drawn as a single closed polygon
    // so the fill surface is correct. Any gap degrades to one or more
    // polylines (open shapes) — matching Excel's behaviour where a
    // missing category breaks the polygon ring.
    const noGap = segments.length === 1 && segments[0].length === series.points.length;
    if (noGap) {
      const pts = segments[0].map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
      parts.push(
        `<polygon points="${pts}" fill="${series.filled ? withAlpha(series.color, 0.35) : "none"}" stroke="${series.color}" stroke-width="2"/>`
      );
    } else {
      for (const seg of segments) {
        if (seg.length < 2) {
          continue;
        }
        const pts = seg.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
        parts.push(
          `<polyline points="${pts}" fill="${series.filled ? withAlpha(series.color, 0.35) : "none"}" stroke="${series.color}" stroke-width="2"/>`
        );
      }
    }
  } else if (series.type === "stock") {
    for (const candle of series.candles) {
      parts.push(
        `<line x1="${fmt(candle.x)}" y1="${fmt(candle.highY)}" x2="${fmt(candle.x)}" y2="${fmt(candle.lowY)}" stroke="#555"/>`
      );
      // A candle body needs BOTH open and close to form a real
      // rectangle. The old code fell back to `closeY ?? openY` for the
      // height, which collapses to a forced-1px strip — a horizontal
      // line drawn at the open price that looks like a legit minimum-
      // height candle body but was actually a rendering artefact when
      // close was absent. Suppress the body entirely when either endpoint
      // is missing; the HLC wick already conveys the data.
      if (candle.openY !== undefined && candle.closeY !== undefined) {
        const y = Math.min(candle.openY, candle.closeY);
        const h = Math.max(1, Math.abs(candle.closeY - candle.openY));
        parts.push(
          `<rect x="${fmt(candle.x - candle.width / 2)}" y="${fmt(y)}" width="${fmt(candle.width)}" height="${fmt(h)}" fill="${candle.up ? "#70AD47" : "#C00000"}" stroke="#555"/>`
        );
      }
    }
  } else if (series.type === "surface") {
    for (const cell of series.cells) {
      parts.push(
        `<rect x="${fmt(cell.x)}" y="${fmt(cell.y)}" width="${fmt(cell.width)}" height="${fmt(cell.height)}" fill="${cell.color}" stroke="${series.wireframe ? "#555" : cell.color}" stroke-width="${series.wireframe ? 1 : 0}"/>`
      );
    }
  }
  if (filterId) {
    parts.push(`</g>`);
  }
  // Adornments (markers, data labels, trendlines, error bars) are
  // emitted in a second pass by `renderChartSvg` — see the two-pass
  // comment at the top of the series loop. Emitting them inline here
  // would paint them under later series' shapes.
}

function renderSvgAdornments(parts: string[], series: ChartSceneAdornment): void {
  for (const errorBar of series.errorBars ?? []) {
    parts.push(renderSvgLine(errorBar.line));
    if (errorBar.cap1) {
      parts.push(renderSvgLine(errorBar.cap1));
    }
    if (errorBar.cap2) {
      parts.push(renderSvgLine(errorBar.cap2));
    }
  }
  for (const trendline of series.trendlines ?? []) {
    // Segment the polyline at NaN gaps so moving-average trendlines —
    // which legitimately emit NaN for leading positions before the
    // window fills — don't spike through `(x, 0)` via `fmt(NaN)`.
    const dashAttr = trendline.dash ? ' stroke-dasharray="4 3"' : "";
    for (const segment of segmentFinitePoints(trendline.points)) {
      if (segment.length < 2) {
        continue;
      }
      parts.push(
        `<polyline points="${segment.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}" fill="none" stroke="${trendline.color}" stroke-width="${trendline.width ?? 1.5}"${dashAttr}/>`
      );
    }
    if (trendline.label) {
      parts.push(renderSvgText(trendline.label));
    }
  }
  for (const marker of series.markers ?? []) {
    parts.push(renderSvgMarker(marker));
  }
  // Leader lines render *before* labels so the label glyphs visually sit on
  // top of the line rather than being bisected by it.
  for (const leader of series.leaderLines ?? []) {
    parts.push(renderSvgLine(leader));
  }
  for (const label of series.labels ?? []) {
    parts.push(renderSvgText(label));
  }
}

function renderSvgMarker(marker: ChartSceneMarker): string {
  const r = marker.size / 2;
  if (marker.symbol === "square") {
    return `<rect x="${fmt(marker.x - r)}" y="${fmt(marker.y - r)}" width="${fmt(marker.size)}" height="${fmt(marker.size)}" fill="${marker.color}"/>`;
  }
  if (marker.symbol === "diamond") {
    return `<polygon points="${fmt(marker.x)},${fmt(marker.y - r)} ${fmt(marker.x + r)},${fmt(marker.y)} ${fmt(marker.x)},${fmt(marker.y + r)} ${fmt(marker.x - r)},${fmt(marker.y)}" fill="${marker.color}"/>`;
  }
  if (marker.symbol === "triangle") {
    return `<polygon points="${fmt(marker.x)},${fmt(marker.y - r)} ${fmt(marker.x + r)},${fmt(marker.y + r)} ${fmt(marker.x - r)},${fmt(marker.y + r)}" fill="${marker.color}"/>`;
  }
  if (marker.symbol === "x" || marker.symbol === "plus") {
    const diagonal = marker.symbol === "x";
    const lines = diagonal
      ? [
          `<line x1="${fmt(marker.x - r)}" y1="${fmt(marker.y - r)}" x2="${fmt(marker.x + r)}" y2="${fmt(marker.y + r)}" stroke="${marker.color}" stroke-width="2"/>`,
          `<line x1="${fmt(marker.x + r)}" y1="${fmt(marker.y - r)}" x2="${fmt(marker.x - r)}" y2="${fmt(marker.y + r)}" stroke="${marker.color}" stroke-width="2"/>`
        ]
      : [
          `<line x1="${fmt(marker.x - r)}" y1="${fmt(marker.y)}" x2="${fmt(marker.x + r)}" y2="${fmt(marker.y)}" stroke="${marker.color}" stroke-width="2"/>`,
          `<line x1="${fmt(marker.x)}" y1="${fmt(marker.y - r)}" x2="${fmt(marker.x)}" y2="${fmt(marker.y + r)}" stroke="${marker.color}" stroke-width="2"/>`
        ];
    return lines.join("");
  }
  return `<circle cx="${fmt(marker.x)}" cy="${fmt(marker.y)}" r="${fmt(r)}" fill="${marker.color}"/>`;
}

/**
 * Render a bar as an extruded 3D box using the supplied projection
 * deltas. Three visible faces:
 *
 *   1. **Top** — quadrilateral whose back edge sits at
 *      `(x+dx, y-dy)` / `(x+w+dx, y-dy)`. Painted lighter than the
 *      front so the viewer reads "light from above".
 *   2. **Right** — quadrilateral from front-right edge to back-right
 *      edge. Painted slightly darker than the front.
 *   3. **Front** — the original `bar` rectangle, unchanged.
 *
 * The shading uses the series' base color with fixed tints so plain
 * `#4472C4` (the default Office colour) ends up with a believable 3D
 * cue without loading a full lighting model.
 */
function renderBar3DBox(
  bar: ChartSceneRect,
  proj: { dx: number; dy: number },
  color: string,
  horizontal: boolean | undefined
): string {
  const right = bar.x + bar.width;
  const top = bar.y;
  const bottom = bar.y + bar.height;
  const dx = proj.dx;
  const dy = proj.dy;
  // Back corners.
  const bx1 = bar.x + dx;
  const by1 = top - dy;
  const bx2 = right + dx;
  const by2 = top - dy;
  const bxBottom = right + dx;
  const byBottom = bottom - dy;
  const topFill = withAlpha(color, 0.92);
  const rightFill = withAlpha(color, 0.75);
  const parts: string[] = [];
  // For horizontal bars we draw the same three faces but the "top" is
  // actually the top edge of the horizontal bar (still a parallelogram
  // along the depth vector).
  if (horizontal) {
    // Top edge + right (front-facing when horizontal) + front face.
    parts.push(
      `<polygon points="${fmt(bar.x)},${fmt(top)} ${fmt(bx1)},${fmt(by1)} ${fmt(bx2)},${fmt(by2)} ${fmt(right)},${fmt(top)}" fill="${topFill}"/>`,
      `<polygon points="${fmt(right)},${fmt(top)} ${fmt(bx2)},${fmt(by2)} ${fmt(bxBottom)},${fmt(byBottom)} ${fmt(right)},${fmt(bottom)}" fill="${rightFill}"/>`,
      `<rect x="${fmt(bar.x)}" y="${fmt(bar.y)}" width="${fmt(bar.width)}" height="${fmt(bar.height)}" fill="${color}"/>`
    );
  } else {
    parts.push(
      // Top face — front-top-left → back-top-left → back-top-right → front-top-right
      `<polygon points="${fmt(bar.x)},${fmt(top)} ${fmt(bx1)},${fmt(by1)} ${fmt(bx2)},${fmt(by2)} ${fmt(right)},${fmt(top)}" fill="${topFill}"/>`,
      // Right face — front-top-right → back-top-right → back-bottom-right → front-bottom-right
      `<polygon points="${fmt(right)},${fmt(top)} ${fmt(bx2)},${fmt(by2)} ${fmt(bxBottom)},${fmt(byBottom)} ${fmt(right)},${fmt(bottom)}" fill="${rightFill}"/>`,
      // Front face — the original rect.
      `<rect x="${fmt(bar.x)}" y="${fmt(bar.y)}" width="${fmt(bar.width)}" height="${fmt(bar.height)}" fill="${color}"/>`
    );
  }
  return parts.join("");
}

function renderSvgPieSlice(slice: ChartScenePieSlice): string {
  // Full-sweep slice (single-value pie): SVG arcs can't describe a
  // full 360° circle with a single `A` command — start and end points
  // coincide, so the renderer returns an empty path. Emit a
  // `<circle>` (or a doughnut `<path>` built from two semicircles) in
  // that case. A tiny epsilon guards against floating drift when the
  // sweep is computed as `100 / total * 2π` on integer totals.
  //
  // `sweepRaw` may be negative if a caller (e.g. `translatePieSlice`
  // in `flipY` mode, or a hand-built slice) passes `endAngle <
  // startAngle`. A raw negative value would land in `large = 0`
  // without the absolute-value guard and the arc draws the *long* way
  // round (covering `2π - |sweep|` of the circle). Normalise on the
  // magnitude and track the direction in the SVG `sweep-flag`.
  const sweepRaw = slice.endAngle - slice.startAngle;
  const sweep = Math.abs(sweepRaw);
  if (sweep >= Math.PI * 2 - 1e-9) {
    if (slice.innerRadius > 0) {
      // Doughnut full-ring: concatenate two 180° arcs on each radius.
      const r = slice.radius;
      const ir = slice.innerRadius;
      return (
        `<path d="M ${fmt(slice.cx - r)} ${fmt(slice.cy)} ` +
        `A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(slice.cx + r)} ${fmt(slice.cy)} ` +
        `A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(slice.cx - r)} ${fmt(slice.cy)} ` +
        `M ${fmt(slice.cx - ir)} ${fmt(slice.cy)} ` +
        `A ${fmt(ir)} ${fmt(ir)} 0 1 0 ${fmt(slice.cx + ir)} ${fmt(slice.cy)} ` +
        `A ${fmt(ir)} ${fmt(ir)} 0 1 0 ${fmt(slice.cx - ir)} ${fmt(slice.cy)} Z" ` +
        `fill="${slice.color}" fill-rule="evenodd"/>`
      );
    }
    return `<circle cx="${fmt(slice.cx)}" cy="${fmt(slice.cy)}" r="${fmt(slice.radius)}" fill="${slice.color}"/>`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const sweepFlag = sweepRaw >= 0 ? 1 : 0;
  const innerSweepFlag = sweepRaw >= 0 ? 0 : 1;
  const x1 = slice.cx + Math.cos(slice.startAngle) * slice.radius;
  const y1 = slice.cy + Math.sin(slice.startAngle) * slice.radius;
  const x2 = slice.cx + Math.cos(slice.endAngle) * slice.radius;
  const y2 = slice.cy + Math.sin(slice.endAngle) * slice.radius;
  if (slice.innerRadius > 0) {
    const ix1 = slice.cx + Math.cos(slice.endAngle) * slice.innerRadius;
    const iy1 = slice.cy + Math.sin(slice.endAngle) * slice.innerRadius;
    const ix2 = slice.cx + Math.cos(slice.startAngle) * slice.innerRadius;
    const iy2 = slice.cy + Math.sin(slice.startAngle) * slice.innerRadius;
    return `<path d="M ${fmt(x1)} ${fmt(y1)} A ${fmt(slice.radius)} ${fmt(slice.radius)} 0 ${large} ${sweepFlag} ${fmt(x2)} ${fmt(y2)} L ${fmt(ix1)} ${fmt(iy1)} A ${fmt(slice.innerRadius)} ${fmt(slice.innerRadius)} 0 ${large} ${innerSweepFlag} ${fmt(ix2)} ${fmt(iy2)} Z" fill="${slice.color}" data-sector="${fmt(slice.cx)},${fmt(slice.cy)},${fmt(slice.radius)},${fmt(slice.innerRadius)},${fmt(slice.startAngle)},${fmt(slice.endAngle)}"/>`;
  }
  return `<path d="M ${fmt(slice.cx)} ${fmt(slice.cy)} L ${fmt(x1)} ${fmt(y1)} A ${fmt(slice.radius)} ${fmt(slice.radius)} 0 ${large} ${sweepFlag} ${fmt(x2)} ${fmt(y2)} Z" fill="${slice.color}" data-sector="${fmt(slice.cx)},${fmt(slice.cy)},${fmt(slice.radius)},0,${fmt(slice.startAngle)},${fmt(slice.endAngle)}"/>`;
}

function renderSvgDataTable(parts: string[], table: ChartSceneDataTable): void {
  // Borders first so cell text paints on top. Order matters for the
  // BasicRasterCanvas too — that canvas scans the SVG top-to-bottom.
  for (const line of table.borders) {
    parts.push(renderSvgLine(line));
  }
  for (const swatch of table.legendSwatches) {
    parts.push(
      `<rect x="${fmt(swatch.x)}" y="${fmt(swatch.y)}" width="${fmt(swatch.width)}" height="${fmt(swatch.height)}" fill="${swatch.color}"/>`
    );
  }
  for (const cell of table.cells) {
    parts.push(renderSvgText(cell));
  }
}

function renderSvgLegend(parts: string[], legend: ChartSceneLegend): void {
  if (!legend.visible || legend.items.length === 0) {
    return;
  }
  const fontSize = legend.textStyle?.fontSize ?? 10;
  const fontFamily = legend.textStyle?.fontFamily ?? "Arial";
  const color = legend.textStyle?.color ?? "#555";
  const weightAttr = legend.textStyle?.bold ? ' font-weight="bold"' : "";
  const styleAttr = legend.textStyle?.italic ? ' font-style="italic"' : "";
  const bold = legend.textStyle?.bold;
  const italic = legend.textStyle?.italic;
  const swatchSize = 10;
  const swatchToLabelGap = 4;
  const interItemGap = 16;
  // Walk horizontally with `estimateTextWidth` so long labels don't
  // overlap the next swatch. Previously the SVG path divided
  // `rect.width / items.length` into equal slots regardless of label
  // length, producing visibly-different output from the PDF path
  // (`drawPdfLegend`) which already cursor-advances with measured
  // widths. Chart round-trip tests that compared SVG ↔ PDF swatch
  // positions drifted for any chart with asymmetric label lengths.
  let cursorX = legend.rect.x;
  legend.items.forEach((item, i) => {
    const itemX = legend.orientation === "horizontal" ? cursorX : legend.rect.x;
    const y = legend.orientation === "horizontal" ? legend.rect.y : legend.rect.y + i * 18;
    parts.push(
      `<rect x="${fmt(itemX)}" y="${fmt(y)}" width="${swatchSize}" height="${swatchSize}" fill="${item.color}"/>`
    );
    parts.push(
      `<text x="${fmt(itemX + swatchSize + swatchToLabelGap)}" y="${fmt(y + 9)}" font-family="${escapeXmlAttr(fontFamily)}" font-size="${fontSize}" fill="${color}"${weightAttr}${styleAttr}>${escapeXml(item.label)}</text>`
    );
    if (legend.orientation === "horizontal") {
      const labelWidth = estimateTextWidth(item.label, fontSize, {
        bold,
        italic,
        fontName: fontFamily
      });
      cursorX += swatchSize + swatchToLabelGap + labelWidth + interItemGap;
    }
  });
}

function renderSvgLine(line: ChartSceneLine): string {
  return `<line x1="${fmt(line.x1)}" y1="${fmt(line.y1)}" x2="${fmt(line.x2)}" y2="${fmt(line.y2)}" stroke="${line.color}" stroke-width="${line.width ?? 1}"/>`;
}

/**
 * Split a list of points into contiguous runs of finite `(x, y)` pairs.
 * A non-finite coordinate (typically `NaN` propagated from a blank /
 * `#N/A` source cell by `collectNumberValues`) terminates the current
 * segment so the rendered polyline / polygon breaks at the gap instead
 * of collapsing to `(x, 0)` via `fmt(NaN) === "0"`.
 *
 * Matches Excel's default `dispBlanksAs="gap"` behaviour for line /
 * scatter / area charts — the other modes (`"zero"` / `"span"`) are
 * expected to be handled upstream by the scene builder (by mapping
 * NaN to `0` or by filtering out the point respectively).
 */
function segmentFinitePoints(points: readonly ChartScenePoint[]): ChartScenePoint[][] {
  const segments: ChartScenePoint[][] = [];
  let current: ChartScenePoint[] = [];
  for (const p of points) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      current.push(p);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function renderSvgText(text: ChartSceneText): string {
  const transform = text.rotate
    ? ` transform="rotate(${fmt(text.rotate)} ${fmt(text.x)} ${fmt(text.y)})"`
    : "";
  const fontFamily = text.fontFamily ?? "Arial";
  const weightAttr = text.bold ? ' font-weight="bold"' : "";
  const styleAttr = text.italic ? ' font-style="italic"' : "";
  const anchor = text.anchor ?? "start";
  // SVG `<text>` collapses whitespace including newlines, so a
  // multi-line chart title (from a rich-text model with >1 paragraph)
  // renders as one line with spaces in place of `\n`. Split on `\n`
  // and emit `<tspan>` children with an explicit `dy` baseline offset
  // to stack paragraphs. Single-line strings stay on the fast path so
  // the common case is byte-identical with the old output.
  // Accept both LF and CRLF line endings — Windows-authored titles
  // that round-trip via a Buffer or raw-XML reader may arrive with
  // `\r\n` pairs. Previously `split("\n")` left the `\r` attached to
  // the preceding tspan, leaking a literal carriage-return into the
  // SVG and visibly displacing the next paragraph by one em.
  if (/[\r\n]/.test(text.text)) {
    const lines = text.text.split(/\r?\n/);
    const lineHeightEm = 1.2;
    const tspans = lines
      .map(
        (line, i) =>
          `<tspan x="${fmt(text.x)}"${i === 0 ? "" : ` dy="${lineHeightEm}em"`}>${escapeXml(line)}</tspan>`
      )
      .join("");
    return `<text x="${fmt(text.x)}" y="${fmt(text.y)}" text-anchor="${anchor}" font-family="${escapeXmlAttr(fontFamily)}" font-size="${text.fontSize}" fill="${text.color}"${weightAttr}${styleAttr}${transform}>${tspans}</text>`;
  }
  return `<text x="${fmt(text.x)}" y="${fmt(text.y)}" text-anchor="${anchor}" font-family="${escapeXmlAttr(fontFamily)}" font-size="${text.fontSize}" fill="${text.color}"${weightAttr}${styleAttr}${transform}>${escapeXml(text.text)}</text>`;
}

function drawPdfSeries(page: ChartPdfDrawingSurface, series: ChartSceneSeries): void {
  if (series.type === "bar") {
    const fill = hexToPdfColor(series.color);
    for (const bar of series.bars) {
      // Skip bars with NaN/non-finite geometry or zero area — these
      // represent gap points (blank/error source cells) and must not
      // emit invalid coordinates into the PDF stream.
      if (
        !Number.isFinite(bar.x) ||
        !Number.isFinite(bar.y) ||
        !Number.isFinite(bar.width) ||
        !Number.isFinite(bar.height) ||
        (bar.width === 0 && bar.height === 0)
      ) {
        continue;
      }
      // Skip the front-face rect here when the series has a `projection3D`
      // hint — the dedicated bar3D pass at the end of this function
      // (`drawPdfBar3DBox`) paints the front face itself along with the
      // top and right shaded faces, so drawing it a second time here
      // would over-composite opaque PDF fills and double-stroke outlines
      // on surfaces that don't honour alpha compositing.
      if (series.projection3D && series.depth && series.depth > 0) {
        continue;
      }
      // When bars are extremely narrow (dense data — thousands of
      // categories), draw a small filled dot instead of a hair-thin
      // rect. This matches Excel's rendering where sub-pixel bars
      // appear as dots rather than vertical lines.
      // After translateScene flipY, bar.y is the PDF bottom edge and
      // bar.y + bar.height is the top edge (value end of the bar).
      if (bar.width < 2) {
        const cx = bar.x + bar.width / 2;
        const cy = bar.y + bar.height;
        if (page.drawCircle) {
          page.drawCircle({ cx, cy, r: 1.2, fill });
        } else {
          page.drawRect({ x: cx - 1, y: cy - 1, width: 2, height: 2, fill });
        }
      } else {
        page.drawRect({ ...bar, fill });
      }
    }
  } else if (series.type === "area") {
    if (page.drawPath && series.points.length > 0) {
      const lowerSource =
        series.lowerPoints ?? series.points.map(p => ({ x: p.x, y: series.baselineY }));
      // Draw one closed path per contiguous finite run of upper points
      // so NaN gaps produce real breaks in the fill instead of zero-
      // height spikes pulled from `fmt(NaN)` downstream. Match the
      // matching lower slice by x-range.
      for (const segment of segmentFinitePoints(series.points)) {
        if (segment.length === 0) {
          continue;
        }
        const startX = segment[0].x;
        const endX = segment[segment.length - 1].x;
        const lowerSegment = lowerSource.filter(
          p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= startX && p.x <= endX
        );
        if (lowerSegment.length === 0) {
          continue;
        }
        const ops: ChartPdfPathOp[] = [
          { op: "move", x: lowerSegment[0].x, y: lowerSegment[0].y },
          ...segment.map(p => ({ op: "line" as const, x: p.x, y: p.y })),
          ...lowerSegment
            .slice()
            .reverse()
            .map(p => ({ op: "line" as const, x: p.x, y: p.y })),
          { op: "close" }
        ];
        // Match the SVG path's `withAlpha(color, 0.35)` fill so
        // stacked areas behind the current one remain visible through
        // the translucent polygon. Opaque fallback for surfaces that
        // ignore `PdfColor.a` — same degradation policy as everywhere
        // else.
        page.drawPath(ops, { fill: hexToPdfColorWithAlpha(series.color, 0.35) });
      }
    }
    // Split the line at NaN gaps so blanks show as breaks rather than
    // `(x, 0)` spikes. Mirrors the SVG `segmentFinitePoints` path.
    for (const segment of segmentFinitePoints(series.points)) {
      for (let i = 1; i < segment.length; i++) {
        page.drawLine({
          x1: segment[i - 1].x,
          y1: segment[i - 1].y,
          x2: segment[i].x,
          y2: segment[i].y,
          color: hexToPdfColor(series.color)
        });
      }
    }
  } else if (series.type === "line" || series.type === "scatter") {
    // Honour `showLine === false` — pure-marker scatter charts and line
    // charts with the line removed via style shouldn't paint an
    // implicit connector. The SVG path checks this flag; the PDF
    // branch used to unconditionally draw the line even when the
    // caller asked for markers only.
    if (series.showLine !== false) {
      for (const segment of segmentFinitePoints(series.points)) {
        for (let i = 1; i < segment.length; i++) {
          page.drawLine({
            x1: segment[i - 1].x,
            y1: segment[i - 1].y,
            x2: segment[i].x,
            y2: segment[i].y,
            color: hexToPdfColor(series.color)
          });
        }
      }
    }
    for (const point of series.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        continue;
      }
      page.drawRect({
        x: point.x - 2,
        y: point.y - 2,
        width: 4,
        height: 4,
        fill: hexToPdfColor(series.color)
      });
    }
  } else if (series.type === "bubble") {
    for (const bubble of series.bubbles) {
      // Bubble SVG uses `withAlpha(color, 0.55)`; emit real alpha in
      // PDF so overlapping bubbles remain distinguishable.
      const fill = hexToPdfColorWithAlpha(series.color, 0.55);
      if (page.drawCircle) {
        page.drawCircle({
          cx: bubble.x,
          cy: bubble.y,
          r: bubble.radius,
          fill
        });
      } else {
        page.drawRect({
          x: bubble.x - bubble.radius,
          y: bubble.y - bubble.radius,
          width: bubble.radius * 2,
          height: bubble.radius * 2,
          fill
        });
      }
    }
  } else if (series.type === "pie" || series.type === "doughnut") {
    if (page.drawPath) {
      for (const slice of series.slices) {
        page.drawPath(pieSliceToPath(slice), { fill: hexToPdfColor(slice.color) });
      }
    } else {
      // Surfaces without drawPath degrade to slice-outline strokes so the
      // chart is still recognisable. The filled area is lost (we have
      // no way to fill a polygon without drawPath), but the slice
      // boundaries and doughnut ring read clearly.
      for (const slice of series.slices) {
        strokePieSliceOutline(page, slice, hexToPdfColor(slice.color));
      }
    }
  } else if (series.type === "ofPie") {
    if (page.drawPath) {
      for (const slice of [...series.slices, ...(series.secondarySlices ?? [])]) {
        page.drawPath(pieSliceToPath(slice), { fill: hexToPdfColor(slice.color) });
      }
    } else {
      for (const slice of [...series.slices, ...(series.secondarySlices ?? [])]) {
        strokePieSliceOutline(page, slice, hexToPdfColor(slice.color));
      }
    }
    for (const line of series.connectors ?? []) {
      page.drawLine({ ...line, color: hexToPdfColor(line.color) });
    }
  } else if (series.type === "radar") {
    // Split at non-finite vertices so gaps don't drag the polygon
    // through the plot centre. Mirrors the SVG path.
    const segments = segmentFinitePoints(series.points);
    const noGap = segments.length === 1 && segments[0].length === series.points.length;
    // Filled radar: the SVG path draws a `withAlpha(color, 0.35)` polygon
    // before the stroke loop. Mirror that here when `drawPath` is
    // available AND the polygon is gap-free (a partial polygon with
    // holes produces ambiguous fill — skip it, matching the SVG
    // `polyline` degradation above). When `drawPath` is absent the
    // stroke loop below alone preserves the polygon shape, which is
    // the best degradation a drawLine-only surface can offer.
    if (series.filled && page.drawPath && noGap && segments[0].length > 0) {
      const seg = segments[0];
      const ops: ChartPdfPathOp[] = [
        { op: "move", x: seg[0].x, y: seg[0].y },
        ...seg.slice(1).map(p => ({ op: "line" as const, x: p.x, y: p.y })),
        { op: "close" }
      ];
      page.drawPath(ops, { fill: hexToPdfColorWithAlpha(series.color, 0.35) });
    }
    for (const seg of segments) {
      if (seg.length < 2) {
        continue;
      }
      // Emit strokes between consecutive finite vertices only. Close
      // the loop only when the series has no gaps — a partial polygon
      // stays open at the gap.
      for (let i = 0; i < seg.length - 1; i++) {
        page.drawLine({
          x1: seg[i].x,
          y1: seg[i].y,
          x2: seg[i + 1].x,
          y2: seg[i + 1].y,
          color: hexToPdfColor(series.color),
          lineWidth: 2
        });
      }
      if (noGap && seg.length > 1) {
        page.drawLine({
          x1: seg[seg.length - 1].x,
          y1: seg[seg.length - 1].y,
          x2: seg[0].x,
          y2: seg[0].y,
          color: hexToPdfColor(series.color),
          lineWidth: 2
        });
      }
    }
  } else if (series.type === "stock") {
    for (const candle of series.candles) {
      page.drawLine({
        x1: candle.x,
        y1: candle.highY,
        x2: candle.x,
        y2: candle.lowY,
        color: hexToPdfColor("#555555")
      });
      // See SVG path — render the candle body only when BOTH open and
      // close are known. Previously a missing close silently collapsed
      // to a 1-px strip at the open price.
      if (candle.openY !== undefined && candle.closeY !== undefined) {
        page.drawRect({
          x: candle.x - candle.width / 2,
          y: Math.min(candle.openY, candle.closeY),
          width: candle.width,
          height: Math.max(1, Math.abs(candle.closeY - candle.openY)),
          fill: hexToPdfColor(candle.up ? "#70AD47" : "#C00000")
        });
      }
    }
  } else if (series.type === "surface") {
    for (const cell of series.cells) {
      page.drawRect({ ...cell, fill: hexToPdfColor(cell.color) });
    }
  }
}

function drawPdfDataTable(
  page: ChartPdfDrawingSurface,
  table: ChartSceneDataTable,
  trace: string[] | undefined
): void {
  for (const line of table.borders) {
    trace?.push(`line:dTable:${fmt(line.x1)},${fmt(line.y1)}-${fmt(line.x2)},${fmt(line.y2)}`);
    page.drawLine({ ...line, color: hexToPdfColor(line.color) });
  }
  for (const swatch of table.legendSwatches) {
    page.drawRect({
      x: swatch.x,
      y: swatch.y,
      width: swatch.width,
      height: swatch.height,
      fill: hexToPdfColor(swatch.color)
    });
  }
  // Render data table cells. When extremely dense, the natural overlap
  // of text glyphs produces the stippled black appearance Excel shows.
  for (const cell of table.cells) {
    trace?.push(`text:dTable:${cell.text}:${fmt(cell.x)},${fmt(cell.y)}`);
    drawPdfText(page, cell);
  }
}

function drawPdfLegend(page: ChartPdfDrawingSurface, legend: ChartSceneLegend): void {
  if (!legend.visible || legend.items.length === 0) {
    return;
  }
  const itemCount = legend.items.length;
  // For dense legends (many items), use smaller font and multi-column
  // grid layout to fit within the available rect.
  const isDense = itemCount > 10;
  const legendFontSize = isDense ? 7 : (legend.textStyle?.fontSize ?? 10);
  const fontFamily = legend.textStyle?.fontFamily;
  const bold = legend.textStyle?.bold;
  const italic = legend.textStyle?.italic;
  const textColor = legend.textStyle?.color ? hexToPdfColor(legend.textStyle.color) : undefined;
  const swatchSize = isDense ? 7 : 10;
  const swatchToLabelGap = 3;
  const interItemGapX = isDense ? 8 : 16;
  const rowHeight = isDense ? 10 : 18;

  if (isDense) {
    // Multi-column grid layout: calculate how many columns fit
    const avgLabelWidth = 50; // rough estimate for truncated labels
    const colWidth = swatchSize + swatchToLabelGap + avgLabelWidth + interItemGapX;
    const availableWidth = legend.rect.width > 0 ? legend.rect.width : 600;
    const cols = Math.max(1, Math.floor(availableWidth / colWidth));

    for (let i = 0; i < itemCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = legend.rect.x + col * colWidth;
      const y = legend.rect.y + row * rowHeight;
      // Stop if we overflow the legend rect vertically
      if (y + rowHeight > legend.rect.y + legend.rect.height) {
        break;
      }
      page.drawRect({
        x,
        y,
        width: swatchSize,
        height: swatchSize,
        fill: hexToPdfColor(legend.items[i].color)
      });
      page.drawText(legend.items[i].label, {
        x: x + swatchSize + swatchToLabelGap,
        y: y + 1,
        fontSize: legendFontSize,
        anchor: "start",
        fontFamily,
        bold,
        italic,
        color: textColor
      });
    }
  } else {
    // Original layout for small legends
    let cursorX = legend.rect.x;
    legend.items.forEach((item, i) => {
      const swatchX = legend.orientation === "horizontal" ? cursorX : legend.rect.x;
      const y = legend.orientation === "horizontal" ? legend.rect.y : legend.rect.y + i * rowHeight;
      page.drawRect({
        x: swatchX,
        y,
        width: swatchSize,
        height: swatchSize,
        fill: hexToPdfColor(item.color)
      });
      page.drawText(item.label, {
        x: swatchX + swatchSize + swatchToLabelGap,
        y: y + 1,
        fontSize: legendFontSize,
        anchor: "start",
        fontFamily,
        bold,
        italic,
        color: textColor
      });
      if (legend.orientation === "horizontal") {
        const labelWidth = estimateTextWidth(item.label, legendFontSize, {
          bold,
          italic,
          fontName: fontFamily
        });
        cursorX += swatchSize + swatchToLabelGap + labelWidth + interItemGapX;
      }
    });
  }
}

function translateScene(
  scene: ChartScene,
  offsetX: number,
  offsetY: number,
  flipY: boolean
): ChartScene {
  const convertY = (y: number) => (flipY ? offsetY + scene.height - y : offsetY + y);
  const mapPoint = (p: ChartScenePoint): ChartScenePoint => ({
    x: offsetX + p.x,
    y: convertY(p.y)
  });
  const mapRect = (r: ChartSceneRect): ChartSceneRect => {
    const y = flipY ? offsetY + scene.height - r.y - r.height : offsetY + r.y;
    return { x: offsetX + r.x, y, width: r.width, height: r.height };
  };
  const mapLine = (line: ChartSceneLine): ChartSceneLine => ({
    ...line,
    x1: offsetX + line.x1,
    y1: convertY(line.y1),
    x2: offsetX + line.x2,
    y2: convertY(line.y2)
  });
  const mapText = (text: ChartSceneText): ChartSceneText => ({
    ...text,
    x: offsetX + text.x,
    y: convertY(text.y)
  });
  return {
    ...scene,
    title: scene.title ? mapText(scene.title) : undefined,
    plot: mapRect(scene.plot),
    axes: {
      x: scene.axes.x ? mapLine(scene.axes.x) : undefined,
      y: scene.axes.y ? mapLine(scene.axes.y) : undefined,
      x2: scene.axes.x2 ? mapLine(scene.axes.x2) : undefined,
      y2: scene.axes.y2 ? mapLine(scene.axes.y2) : undefined
    },
    gridlines: scene.gridlines.map(mapLine),
    xLabels: scene.xLabels.map(mapText),
    yLabels: scene.yLabels.map(mapText),
    secondaryXLabels: scene.secondaryXLabels.map(mapText),
    secondaryYLabels: scene.secondaryYLabels.map(mapText),
    axisTitles: scene.axisTitles.map(mapText),
    legend: { ...scene.legend, rect: mapRect(scene.legend.rect) },
    dataTable: scene.dataTable
      ? {
          rect: mapRect(scene.dataTable.rect),
          // Column/row arrays are plain x/y scalars — columns is an array
          // of x (no flip) and rows is an array of y (flip-aware via
          // convertY). We remap them so downstream consumers can still
          // use them in the translated frame.
          columns: scene.dataTable.columns.map(x => offsetX + x),
          rows: scene.dataTable.rows.map(y => convertY(y)),
          cells: scene.dataTable.cells.map(mapText),
          legendSwatches: scene.dataTable.legendSwatches.map(s => ({
            ...mapRect(s),
            color: s.color
          })),
          borders: scene.dataTable.borders.map(mapLine)
        }
      : undefined,
    series: scene.series.map(s => translateSeries(s, mapPoint, mapRect, mapLine, mapText, flipY))
  };
}

function translateSeries(
  series: ChartSceneSeries,
  mapPoint: (point: ChartScenePoint) => ChartScenePoint,
  mapRect: (rect: ChartSceneRect) => ChartSceneRect,
  mapLine: (line: ChartSceneLine) => ChartSceneLine,
  mapText: (text: ChartSceneText) => ChartSceneText,
  flipY: boolean
): ChartSceneSeries {
  if (series.type === "bar") {
    // `projection3D` is a pair of screen-space deltas, not positions,
    // so `mapRect` doesn't touch it. When `flipY=true` (PDF y-up) the
    // `dy` sign must be negated so the back face of each bar still
    // extrudes "upward" relative to the front face in the flipped
    // frame. Without this, PDF bar3D extrudes downward — the opposite
    // of the SVG rendering.
    const projection3D = series.projection3D
      ? { dx: series.projection3D.dx, dy: flipY ? -series.projection3D.dy : series.projection3D.dy }
      : undefined;
    return translateAdornments(
      { ...series, bars: series.bars.map(mapRect), projection3D },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "line" || series.type === "scatter") {
    return translateAdornments(
      { ...series, points: series.points.map(mapPoint) },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "radar") {
    return translateAdornments(
      {
        ...series,
        points: series.points.map(mapPoint),
        center: mapPoint(series.center)
      },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "area") {
    return translateAdornments(
      {
        ...series,
        points: series.points.map(mapPoint),
        lowerPoints: series.lowerPoints?.map(mapPoint),
        baselineY: mapPoint({ x: 0, y: series.baselineY }).y
      },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "bubble") {
    return translateAdornments(
      { ...series, bubbles: series.bubbles.map(b => ({ ...mapPoint(b), radius: b.radius })) },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "pie" || series.type === "doughnut") {
    return translateAdornments(
      { ...series, slices: series.slices.map(slice => translatePieSlice(slice, mapPoint, flipY)) },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "ofPie") {
    return translateAdornments(
      {
        ...series,
        slices: series.slices.map(slice => translatePieSlice(slice, mapPoint, flipY)),
        secondarySlices: series.secondarySlices?.map(slice =>
          translatePieSlice(slice, mapPoint, flipY)
        ),
        connectors: series.connectors?.map(line => ({
          ...line,
          ...lineFromPoints(
            mapPoint({ x: line.x1, y: line.y1 }),
            mapPoint({ x: line.x2, y: line.y2 })
          )
        }))
      },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "stock") {
    return translateAdornments(
      {
        ...series,
        candles: series.candles.map(c => ({
          ...c,
          x: mapPoint({ x: c.x, y: 0 }).x,
          highY: mapPoint({ x: 0, y: c.highY }).y,
          lowY: mapPoint({ x: 0, y: c.lowY }).y,
          openY: c.openY === undefined ? undefined : mapPoint({ x: 0, y: c.openY }).y,
          closeY: c.closeY === undefined ? undefined : mapPoint({ x: 0, y: c.closeY }).y
        }))
      },
      mapPoint,
      mapLine,
      mapText
    );
  }
  if (series.type === "surface") {
    return translateAdornments(
      { ...series, cells: series.cells.map(cell => ({ ...cell, ...mapRect(cell) })) },
      mapPoint,
      mapLine,
      mapText
    );
  }
  return series;
}

function translateAdornments<T extends ChartSceneSeries>(
  series: T,
  mapPoint: (point: ChartScenePoint) => ChartScenePoint,
  mapLine: (line: ChartSceneLine) => ChartSceneLine,
  mapText: (text: ChartSceneText) => ChartSceneText
): T {
  return {
    ...series,
    labels: series.labels?.map(mapText),
    markers: series.markers?.map(m => ({ ...m, ...mapPoint(m) })),
    trendlines: series.trendlines?.map(t => ({
      ...t,
      points: t.points.map(mapPoint),
      label: t.label ? mapText(t.label) : undefined
    })),
    errorBars: series.errorBars?.map(e => ({
      line: mapLine(e.line),
      cap1: e.cap1 ? mapLine(e.cap1) : undefined,
      cap2: e.cap2 ? mapLine(e.cap2) : undefined
    })),
    leaderLines: series.leaderLines?.map(mapLine)
  };
}

function translatePieSlice(
  slice: ChartScenePieSlice,
  mapPoint: (point: ChartScenePoint) => ChartScenePoint,
  flipY: boolean
): ChartScenePieSlice {
  const center = mapPoint({ x: slice.cx, y: slice.cy });
  // Flipping `Y` geometrically mirrors the slice, so the sweep
  // direction must invert. When `flipY` is false the caller is only
  // translating the scene — angles must stay untouched, otherwise the
  // pie re-orders its wedges after any `offset`-only transform.
  if (flipY) {
    return {
      ...slice,
      cx: center.x,
      cy: center.y,
      startAngle: -slice.endAngle,
      endAngle: -slice.startAngle
    };
  }
  return {
    ...slice,
    cx: center.x,
    cy: center.y
  };
}

function lineFromPoints(
  p1: ChartScenePoint,
  p2: ChartScenePoint
): Pick<ChartSceneLine, "x1" | "y1" | "x2" | "y2"> {
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/**
 * Stroke the outline of a pie / doughnut slice with `drawLine` calls.
 *
 * Used by {@link drawPdfSeries} as a fallback when the target surface
 * does not implement `drawPath` — without it, pie charts would be
 * completely invisible on minimal surfaces. The outline uses the same
 * polyline approximation of the arc (`arcPolyline`) that
 * {@link pieSliceToPath} builds for the filled version, so the shape
 * matches pixel-for-pixel modulo fill/no-fill.
 */
function strokePieSliceOutline(
  page: ChartPdfDrawingSurface,
  slice: ChartScenePieSlice,
  color: PdfColor
): void {
  const ops = pieSliceToPath(slice);
  let last: { x: number; y: number } | undefined;
  let first: { x: number; y: number } | undefined;
  for (const op of ops) {
    if (op.op === "move") {
      last = { x: op.x, y: op.y };
      first = last;
    } else if (op.op === "line" && last) {
      page.drawLine({ x1: last.x, y1: last.y, x2: op.x, y2: op.y, color });
      last = { x: op.x, y: op.y };
    } else if (op.op === "close" && last && first) {
      page.drawLine({ x1: last.x, y1: last.y, x2: first.x, y2: first.y, color });
      last = undefined;
      first = undefined;
    }
  }
}

function pieSliceToPath(slice: ChartScenePieSlice): ChartPdfPathOp[] {
  const ops: ChartPdfPathOp[] = [];
  const startOuter = polarPoint(slice.cx, slice.cy, slice.radius, slice.startAngle);
  const endOuter = polarPoint(slice.cx, slice.cy, slice.radius, slice.endAngle);
  if (slice.innerRadius > 0) {
    const endInner = polarPoint(slice.cx, slice.cy, slice.innerRadius, slice.endAngle);
    ops.push({ op: "move", ...startOuter });
    ops.push(...arcPolyline(slice.cx, slice.cy, slice.radius, slice.startAngle, slice.endAngle));
    ops.push({ op: "line", ...endInner });
    ops.push(
      ...arcPolyline(slice.cx, slice.cy, slice.innerRadius, slice.endAngle, slice.startAngle)
    );
    ops.push({ op: "close" });
    return ops;
  }
  ops.push({ op: "move", x: slice.cx, y: slice.cy });
  ops.push({ op: "line", ...startOuter });
  ops.push(...arcPolyline(slice.cx, slice.cy, slice.radius, slice.startAngle, slice.endAngle));
  ops.push({ op: "line", ...endOuter });
  ops.push({ op: "close" });
  return ops;
}

function arcPolyline(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
): ChartPdfPathOp[] {
  const sweep = endAngle - startAngle;
  // Use high segment density for smooth arcs: ~1 segment per 2° of sweep,
  // minimum 8 segments. A 36° slice (10% pie) gets 18 segments; a full
  // circle gets 180. This eliminates visible polygon facets in PDF output.
  const segments = Math.max(8, Math.ceil((Math.abs(sweep) * radius) / 3));
  const ops: ChartPdfPathOp[] = [];
  for (let i = 1; i <= segments; i++) {
    ops.push({ op: "line", ...polarPoint(cx, cy, radius, startAngle + (sweep * i) / segments) });
  }
  return ops;
}

function polarPoint(cx: number, cy: number, radius: number, angle: number): ChartScenePoint {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

function collectSeries(group: ChartTypeGroup | undefined): SeriesBase[] {
  return ((group as { series?: SeriesBase[] } | undefined)?.series ?? []) as SeriesBase[];
}

function collectValues(series: SeriesBase): number[] {
  // `SeriesBase` does not declare `val` / `yVal` (they live on the
  // discriminated subclasses like `BarSeries` / `BubbleSeries`), but
  // at render time we walk the heterogeneous `plotArea.chartTypes[].series`
  // array where every series is narrowed only by runtime shape. Widen
  // through `unknown` rather than `any` so the local access stays typed.
  const s = series as SeriesBase & {
    val?: { numRef?: NumberReference; numLit?: NumberLiteral };
    yVal?: { numRef?: NumberReference; numLit?: NumberLiteral };
  };
  // `NumberDataSource` can carry either a formula ref (`numRef`) or
  // inline literal values (`numLit`) per ECMA-376 `CT_NumDataSource`.
  // Excel-authored charts usually use `numRef`, but inline-literal
  // series appear in pivot-chart metadata, and in charts authored by
  // tools that don't emit workbook cells. Previously the renderer only
  // read `numRef.cache`, so literal-only series rendered as flat
  // zero bars. Fall back to `numLit` when no ref is present.
  const ref = s.val?.numRef ?? s.yVal?.numRef;
  if (ref) {
    return collectNumberValues(ref);
  }
  const lit = s.val?.numLit ?? s.yVal?.numLit;
  return collectNumberLiteralValues(lit);
}

function collectNumberValues(ref: NumberReference | undefined): number[] {
  // Preserve "point is a gap" semantics: Excel writes `<c:v>` omitted
  // or `null` in the cached points when the source cell was blank /
  // `#N/A`. Coercing to `0` painted phantom zero-height bars where the
  // user expected a gap. Map to `NaN` so downstream builders
  // (`valueToY`, `buildBars`, `buildLinePoints`) can skip the slot —
  // they already guard `Number.isFinite` for other paths.
  //
  // Honour the sparse `idx` attribute: Excel writes `<c:pt idx="0">A</c:pt>
  // <c:pt idx="2">C</c:pt>` with index 1 missing. The previous
  // `.map(p => p.value)` emitted `[A, C]`, shifting `C` into slot 1 and
  // mis-aligning categories with values downstream. Build a dense
  // array indexed by `p.index`, filling gaps with `NaN`.
  const points = ref?.cache?.points ?? [];
  return densifySparsePoints(points, ref?.cache?.pointCount, NaN, raw =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : NaN
  );
}

/**
 * Hard ceiling for sparse-array densification — prevents malicious or
 * malformed XML from allocating gigabyte-scale arrays via a bogus
 * `<c:ptCount val="...">`. Excel's per-worksheet row limit is
 * 1 048 576; doubling that gives a generous upper bound that still
 * fits comfortably in memory for legitimate workbooks.
 */
const SPARSE_ARRAY_CEILING = 2_097_152;

/**
 * Reconstruct a dense array from OOXML's sparse `<c:pt idx="N">` form.
 * Shared between the numeric (`collectNumberValues`) and string
 * (`collectCategories`) code paths — previously both duplicated the
 * `maxIdx` / `declaredCount` / ceiling logic, and each drift kept
 * quietly mis-routing indices.
 *
 * @param points      Sparse point records with `index` and optional `value`.
 * @param pointCount  The total slot count declared in `<c:ptCount>`.
 * @param empty       Value for slots with no matching point.
 * @param coerce      Maps a raw `value` to the output type; used to
 *                    reject non-finite numbers / non-string category
 *                    values to `empty`.
 */
function densifySparsePoints<T, Raw>(
  points: readonly { index: number; value?: Raw }[],
  pointCount: number | undefined,
  empty: T,
  coerce: (raw: Raw | undefined) => T
): T[] {
  if (points.length === 0) {
    return [];
  }
  let maxIdx = -1;
  for (const p of points) {
    if (typeof p.index === "number" && Number.isFinite(p.index) && p.index > maxIdx) {
      maxIdx = p.index;
    }
  }
  const declaredCount = typeof pointCount === "number" ? pointCount : 0;
  const rawLength = Math.max(points.length, maxIdx + 1, declaredCount);
  const length = Math.min(rawLength, SPARSE_ARRAY_CEILING);
  const dense: T[] = new Array(length).fill(empty);
  for (const p of points) {
    const idx =
      typeof p.index === "number" && Number.isFinite(p.index) && p.index >= 0 ? p.index : -1;
    if (idx < 0 || idx >= length) {
      continue;
    }
    dense[idx] = coerce(p.value);
  }
  return dense;
}

function collectAxisValues(axisData: AxisDataSource | undefined): number[] {
  if (!axisData) {
    return [];
  }
  // Prefer the reference form; fall back to the literal form so
  // literal-only axis data sources (scatter / bubble charts that inline
  // their x values, pivot-chart metadata) still render instead of
  // producing a flat x=0 column.
  if (axisData.numRef) {
    return collectNumberValues(axisData.numRef);
  }
  return collectNumberLiteralValues(axisData.numLit);
}

/**
 * Collect numeric values from a `<c:numLit>` (inline literal) source,
 * treating the result identically to the cached form of `<c:numRef>`.
 * Non-finite / null values become `NaN` so `valueToY` and friends skip
 * them the same way they skip blank-cell-backed gaps.
 */
function collectNumberLiteralValues(lit: NumberLiteral | undefined): number[] {
  if (!lit) {
    return [];
  }
  return densifySparsePoints(lit.points, lit.pointCount, NaN, raw =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : NaN
  );
}

function collectCategories(series: SeriesBase | undefined): string[] | undefined {
  const cat = (series as (SeriesBase & { cat?: AxisDataSource }) | undefined)?.cat;
  if (!cat) {
    return undefined;
  }
  // Prefer the structured string form; fall back to `numRef` (date /
  // numeric categories) so charts whose category axis is date-valued
  // still render tick labels. Previously only string refs were
  // honoured and numeric-category charts rendered with empty labels.
  //
  // The fallback chain must treat "present but empty" the same as
  // "absent" — a `<c:strRef><c:f>…</c:f></c:strRef>` with no cache
  // lands `strRef.cache.points = []` on the model; `??` would stop
  // at that empty array and `numRef.cache.points` would never be
  // consulted. Iterate candidate refs and pick the first non-empty
  // one.
  const strRef = cat.strRef ?? cat.multiLvlStrRef?.cache?.levels?.[0];
  const numRef = cat.numRef;
  type AnyPoint = { index: number; value?: string | number | null };
  const candidates: Array<{
    points: readonly AnyPoint[];
    cache?: { pointCount?: number };
  }> = [];
  // `strRef` is either a `StringReference` (points live in `.cache.points`)
  // or a `StringCache` extracted from a multi-level reference level
  // (points live on the root directly). Probe both shapes.
  const strRefCachePoints = (strRef as StringReference | undefined)?.cache?.points;
  const strRefDirectPoints = (strRef as { points?: readonly AnyPoint[] } | undefined)?.points;
  if (strRefCachePoints && strRefCachePoints.length > 0) {
    candidates.push({
      points: strRefCachePoints,
      cache: (strRef as StringReference).cache
    });
  } else if (strRefDirectPoints && strRefDirectPoints.length > 0) {
    candidates.push({ points: strRefDirectPoints });
  }
  if (numRef?.cache?.points && numRef.cache.points.length > 0) {
    candidates.push({ points: numRef.cache.points, cache: numRef.cache });
  }
  // Fall back to the literal forms (`c:strLit` / `c:numLit`) when no
  // cached reference is available. Charts authored by tools that
  // don't emit backing workbook cells, and some pivot-chart metadata
  // use these exclusively.
  if (candidates.length === 0 && cat.strLit && cat.strLit.points.length > 0) {
    candidates.push({
      points: cat.strLit.points,
      cache: { pointCount: cat.strLit.pointCount }
    });
  }
  if (candidates.length === 0 && cat.numLit && cat.numLit.points.length > 0) {
    candidates.push({
      points: cat.numLit.points,
      cache: { pointCount: cat.numLit.pointCount }
    });
  }
  const chosen = candidates[0];
  if (!chosen) {
    return undefined;
  }
  // Densify via the shared sparse-array helper. String points use the
  // value directly; numeric points (date / numeric categories) are
  // passed through `formatAxisNumber` as a pragmatic fallback — the
  // formal OOXML treatment would honour `cache.formatCode`, which we
  // don't yet parse in full.
  return densifySparsePoints<string, string | number | null>(
    chosen.points,
    chosen.cache?.pointCount,
    "",
    raw => {
      if (typeof raw === "string") {
        return raw;
      }
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return formatAxisNumber(raw);
      }
      return "";
    }
  );
}

function collectSeriesLabel(series: SeriesBase | undefined, index: number): string {
  const tx = (
    series as
      | { tx?: { value?: string; strRef?: { cache?: { points?: Array<{ value: string }> } } } }
      | undefined
  )?.tx;
  return (
    tx?.value ?? tx?.strRef?.cache?.points?.map(p => p.value).join("") ?? `Series ${index + 1}`
  );
}

function extractTitle(model: ChartModel): string | undefined {
  // Reuse `titleToText` so the chart title falls back through all three
  // of Excel's title representations in the same order as axis titles
  // (structured rich text → cached `strRef` values). Previously only
  // `.text` was inspected, which silently dropped the title for any
  // chart whose title is authored as a formula (`<c:tx><c:strRef>…`)
  // — the preview then rendered no title even though the model clearly
  // carries one.
  const title = model.chart.title;
  if (!title) {
    return undefined;
  }
  const text = titleToText(title);
  return text && text.length > 0 ? text : undefined;
}

function formatAxisNumber(value: number): string {
  // Defensive against NaN / ±Infinity reaching the formatter — axis
  // range helpers widen degenerate ranges, but a single stray NaN
  // (e.g. from `(max - min) / 5` when max/min collapse to NaN) would
  // otherwise stamp the literal string `"NaN"` into every tick label.
  if (!Number.isFinite(value)) {
    return "";
  }
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.01) {
    // `toFixed(1)` on tiny fractions collapses to `"0.0"` — every tick
    // on a probability / ratio axis then reads zero. Use scientific
    // notation (`1.00e-3`) so the axis stays readable.
    return value.toExponential(2);
  }
  if (abs >= 1000) {
    return value.toFixed(0);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Truncate a label to at most 12 visible code points, appending
 * `"..."` when the label was cut. `String.length` counts UTF-16 code
 * units — a single surrogate-pair emoji is 2 units, so slicing at
 * `label.slice(0, 11)` can bisect a code point and emit a lone
 * surrogate (invalid Unicode). CJK characters inside the BMP count
 * as 1 each under either measurement, but characters outside the BMP
 * (emoji, some historic scripts, math symbols) need the array walk.
 *
 * Using `Array.from(label)` iterates by code point (the iterator
 * yields one entry per surrogate pair), which is the right
 * granularity for "a visible character" on the preview. True grapheme
 * clusters (e.g. family emoji built from ZWJ sequences) would need
 * `Intl.Segmenter`; the extra complexity isn't worth it for a
 * best-effort tick-label truncator, and `Array.from` is correct for
 * everything except ZWJ-glued sequences.
 */
function truncateLabel(label: string): string {
  if (label.length <= 12) {
    return label;
  }
  const cps = Array.from(label);
  if (cps.length <= 12) {
    return label;
  }
  return `${cps.slice(0, 9).join("")}\u2026`;
}

/**
 * CSS pixels to points. `@excel/utils/text-metrics` reports pixel widths for a
 * point-sized font; chart scene units are the units text is drawn in.
 */
const POINTS_PER_PIXEL = 72 / 96;

/**
 * Measure the rendered pixel width of a label using the Excel module's
 * built-in font metrics engine (`@excel/utils/text-metrics`). This replaces
 * the previous `text.length * fontSize * 0.55` approximation with a real
 * per-character advance-width lookup, which matters wherever the renderer
 * must allocate space for a label (legend width, title centring, PDF
 * anchoring). Chart labels default to Arial to match the SVG emit path
 * (`font-family="Arial"` in renderSvgText), and `bold`/`italic` are
 * forwarded when present — the Excel engine already knows how to degrade
 * to a category-average factor for unrecognised faces.
 */
function estimateTextWidth(
  text: string,
  fontSize: number,
  options: { bold?: boolean; italic?: boolean; fontName?: string } = {}
): number {
  if (!text) {
    return 0;
  }
  // `measureTextWidthPx` takes a point size and returns a CSS-pixel width, so
  // it embeds a 96/72 scale. Chart scenes are a single coordinate space in which
  // text is *drawn* at `fontSize` units — SVG emits `font-size="${fontSize}"`
  // (user units) and the PDF surface passes `fontSize` straight through as
  // points. Returning the pixel width therefore over-allocated every label by
  // 4/3, which pushed legends wider, shifted centred titles left, and
  // ellipsised axis labels that in fact fit.
  return (
    measureTextWidthPx(text, {
      name: options.fontName ?? "arial",
      size: fontSize,
      bold: options.bold,
      italic: options.italic
    }) * POINTS_PER_PIXEL
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load chart SVG image"));
    image.src = url;
  });
}
