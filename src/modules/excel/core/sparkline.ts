/**
 * Sparkline (mini chart) data model and utilities.
 *
 * Sparklines are cell-sized charts stored in the worksheet extLst under
 * `x14:sparklineGroups`. Each group contains:
 *   - display options (type, line weight, markers, axis settings, colors)
 *   - one or more sparklines, each pairing a data reference with an anchor cell.
 *
 * Reference: ECMA-376 §18.18.92 + Office Open XML extension `x14` namespace.
 */

import { toSvg } from "@draw/svg";
import type { DrawList, DrawNode } from "@draw/types";
import { parseCssColor } from "@utils/svg-lex";
import type { Rgba01 } from "@utils/svg-lex";
import { CHART_THEME_PALETTE } from "@utils/theme-colors";
import { xmlEncode } from "@xml/encode";

/**
 * Top-level sparkline group — matches `x14:sparklineGroup`.
 */
export interface SparklineGroup {
  /** Chart type: line | column | stacked (win-loss) */
  type?: SparklineType;
  /** Line weight in points (0.25 - 2.25) */
  lineWeight?: number;
  /** Display empty cells as: gap, zero, or span */
  displayEmptyCellsAs?: "gap" | "zero" | "span";
  /** Whether to display markers */
  markers?: boolean;
  /** High point marker */
  high?: boolean;
  /** Low point marker */
  low?: boolean;
  /** First point marker */
  first?: boolean;
  /** Last point marker */
  last?: boolean;
  /** Negative point marker */
  negative?: boolean;
  /** Display X axis */
  displayXAxis?: boolean;
  /** Display hidden cells data */
  displayHidden?: boolean;
  /** Min axis type: individual, group, custom */
  minAxisType?: SparklineAxisType;
  /** Max axis type */
  maxAxisType?: SparklineAxisType;
  /** Manual min (when minAxisType === "custom") */
  manualMin?: number;
  /** Manual max (when maxAxisType === "custom") */
  manualMax?: number;
  /** Right-to-left */
  rightToLeft?: boolean;
  /** Color series */
  colorSeries?: SparklineColor;
  /** Color negative */
  colorNegative?: SparklineColor;
  /** Color axis */
  colorAxis?: SparklineColor;
  /** Color markers */
  colorMarkers?: SparklineColor;
  /** Color first */
  colorFirst?: SparklineColor;
  /** Color last */
  colorLast?: SparklineColor;
  /** Color high */
  colorHigh?: SparklineColor;
  /** Color low */
  colorLow?: SparklineColor;
  /** Date axis source (reference range of dates) */
  dateAxis?: string;
  /** Sparklines in this group */
  sparklines: SparklineItem[];
}

export type SparklineType = "line" | "column" | "stacked";

export type SparklineAxisType = "individual" | "group" | "custom";

/**
 * A single sparkline within a group.
 */
export interface SparklineItem {
  /** Data reference (e.g. "Sheet1!B2:G2") */
  dataRef: string;
  /** Anchor cell reference (e.g. "H2") */
  cellRef: string;
}

/**
 * Sparkline color — theme reference or sRGB.
 */
export interface SparklineColor {
  /** Theme index (0-11) */
  theme?: number;
  /** sRGB hex */
  rgb?: string;
  /** Tint (-1 to 1) */
  tint?: number;
  /** Auto color */
  auto?: boolean;
}

// ============================================================================
// High-level options for Worksheet.addSparklineGroup
// ============================================================================

/**
 * High-level options for creating a sparkline group.
 */
export interface AddSparklineGroupOptions {
  /** Chart type */
  type: SparklineType;
  /** List of sparklines (data + anchor) */
  sparklines: SparklineItem[];
  /** Line weight in points */
  lineWeight?: number;
  /** Show markers (line type) */
  markers?: boolean;
  /** Show high point */
  high?: boolean;
  /** Show low point */
  low?: boolean;
  /** Show first point */
  first?: boolean;
  /** Show last point */
  last?: boolean;
  /** Show negative points */
  negative?: boolean;
  /** Line color */
  lineColor?: string;
  /** Negative bar color */
  negativeColor?: string;
  /**
   * Colour for the reference line drawn when {@link displayXAxis} is
   * enabled. Maps to `<x14:colorAxis>` — the horizontal rule that
   * separates positive from negative values on a sparkline.
   */
  axisColor?: string;
  /**
   * Colour applied to ordinary marker dots (those that are neither
   * first/last/high/low/negative). Maps to `<x14:colorMarkers>`.
   */
  markerColor?: string;
  /** High marker color */
  highColor?: string;
  /** Low marker color */
  lowColor?: string;
  /** First marker color */
  firstColor?: string;
  /** Last marker color */
  lastColor?: string;
  /** Min axis type */
  minAxisType?: SparklineAxisType;
  /** Max axis type */
  maxAxisType?: SparklineAxisType;
  /** Manual min */
  manualMin?: number;
  /** Manual max */
  manualMax?: number;
  /** Show X axis */
  displayXAxis?: boolean;
  /** Right-to-left */
  rightToLeft?: boolean;
  /** Display empty cells as */
  displayEmptyCellsAs?: "gap" | "zero" | "span";
  /** Date axis source */
  dateAxis?: string;
}

/**
 * Build a SparklineGroup from simplified options.
 */
export function buildSparklineGroup(opts: AddSparklineGroupOptions): SparklineGroup {
  const group: SparklineGroup = {
    type: opts.type,
    sparklines: opts.sparklines
  };
  if (opts.lineWeight !== undefined) {
    group.lineWeight = opts.lineWeight;
  }
  if (opts.markers !== undefined) {
    group.markers = opts.markers;
  }
  if (opts.high !== undefined) {
    group.high = opts.high;
  }
  if (opts.low !== undefined) {
    group.low = opts.low;
  }
  if (opts.first !== undefined) {
    group.first = opts.first;
  }
  if (opts.last !== undefined) {
    group.last = opts.last;
  }
  if (opts.negative !== undefined) {
    group.negative = opts.negative;
  }
  if (opts.lineColor) {
    group.colorSeries = hexToSparklineColor(opts.lineColor);
  }
  if (opts.negativeColor) {
    group.colorNegative = hexToSparklineColor(opts.negativeColor);
  }
  if (opts.axisColor) {
    group.colorAxis = hexToSparklineColor(opts.axisColor);
  }
  if (opts.markerColor) {
    group.colorMarkers = hexToSparklineColor(opts.markerColor);
  }
  if (opts.highColor) {
    group.colorHigh = hexToSparklineColor(opts.highColor);
  }
  if (opts.lowColor) {
    group.colorLow = hexToSparklineColor(opts.lowColor);
  }
  if (opts.firstColor) {
    group.colorFirst = hexToSparklineColor(opts.firstColor);
  }
  if (opts.lastColor) {
    group.colorLast = hexToSparklineColor(opts.lastColor);
  }
  if (opts.minAxisType) {
    group.minAxisType = opts.minAxisType;
  }
  if (opts.maxAxisType) {
    group.maxAxisType = opts.maxAxisType;
  }
  if (opts.manualMin !== undefined) {
    group.manualMin = opts.manualMin;
  }
  if (opts.manualMax !== undefined) {
    group.manualMax = opts.manualMax;
  }
  if (opts.displayXAxis !== undefined) {
    group.displayXAxis = opts.displayXAxis;
  }
  if (opts.rightToLeft !== undefined) {
    group.rightToLeft = opts.rightToLeft;
  }
  if (opts.displayEmptyCellsAs) {
    group.displayEmptyCellsAs = opts.displayEmptyCellsAs;
  }
  if (opts.dateAxis) {
    group.dateAxis = opts.dateAxis;
  }
  return group;
}

/**
 * The eight colours a group gets when it states none, and the value Excel itself writes for each.
 *
 * **Read out of a sparkline created through Excel's own UI**, because the first attempt at this guessed
 * `theme="4"` — accent1 — and that is not what Excel does: it writes concrete sRGB for all eight, `FF376092`
 * for the series and `FFD00000` for every marker except the axis.
 *
 * **These are Excel's *authoring* defaults, and that is a different thing from what Excel does with an
 * omission.** Handed a file whose group states no colour, Excel does not fill one in: it writes the colour out
 * as `xColorType` 0 — automatic — in the binary form, which its own specification says that record MUST NOT
 * contain. So the choice made here is deliberate rather than imitative. Passing an omission through is what
 * Excel does and it produces an invisible chart; substituting what Excel's UI would have chosen produces the
 * one the caller meant. For a library whose documented way of adding a sparkline is
 * `Sparkline.add(sheet, { type, sparklines })`, the second is the only defensible reading.
 *
 * Defaults are needed at all because **a colour Excel does not find is a thing Excel does not paint.** A group
 * with no `<x14:colorSeries>` loads — selecting the cell highlights the source range — and draws nothing, and
 * the same is true one marker at a time: `high: true` with no `colorHigh` is an invisible high point. So all
 * eight are supplied rather than only the series, which was the first fix and was incomplete.
 *
 * Consumed by the XLSB encoder too. It had the identical defect in a different spelling: an unstated colour
 * became palette index 64 — "automatic" — because `BrtBeginSparklineGroup` forbids colour type 0, and
 * automatic is as unpainted there as an absent element is here. One definition, two writers.
 */
export const DEFAULT_SPARKLINE_COLORS = {
  colorSeries: { rgb: "FF376092" },
  colorNegative: { rgb: "FFD00000" },
  colorAxis: { rgb: "FF000000" },
  colorMarkers: { rgb: "FFD00000" },
  colorFirst: { rgb: "FFD00000" },
  colorLast: { rgb: "FFD00000" },
  colorHigh: { rgb: "FFD00000" },
  colorLow: { rgb: "FFD00000" }
} as const satisfies Record<string, SparklineColor>;

/**
 * How empty cells are plotted when the group says nothing.
 *
 * **`gap`, which is not the schema's default.** The XML default is `zero`, and a sparkline inserted through
 * Excel's UI states `displayEmptyCellsAs="gap"` explicitly — precisely because Excel's own choice differs from
 * the schema's. Following the schema meant a gap in the data was drawn as a column of height zero rather than
 * as a break, which is a different chart.
 *
 * As with the colours, this is Excel's *authoring* default and not its passthrough behaviour: given a file that
 * omits the attribute, Excel keeps the omission (`fShowEmptyCellAsZero = 0`). Substituting here is a decision
 * about what an unconfigured `Sparkline.add` should mean, not an imitation of a converter.
 */
export const DEFAULT_SPARKLINE_EMPTY_CELLS = "gap" as const;

function hexToSparklineColor(hex: string): SparklineColor {
  return { rgb: hex.replace(/^#/, "").toUpperCase() };
}

// ============================================================================
// XML rendering
// ============================================================================

/**
 * Render all sparkline groups on a worksheet to an x14:sparklineGroups
 * XML fragment. Returns a string (empty if no groups).
 */
export function renderSparklineGroups(groups: SparklineGroup[]): string {
  if (!groups || groups.length === 0) {
    return "";
  }
  const parts: string[] = [];
  parts.push(
    '<x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
  );
  for (const g of groups) {
    parts.push(renderSparklineGroup(g));
  }
  parts.push("</x14:sparklineGroups>");
  return parts.join("");
}

function renderSparklineGroup(g: SparklineGroup): string {
  const attrs: string[] = [];
  if (g.type !== undefined && g.type !== "line") {
    attrs.push(`type="${g.type}"`);
  }
  if (g.lineWeight !== undefined) {
    attrs.push(`lineWeight="${g.lineWeight}"`);
  }
  // Stated even when the group says nothing, because the default this library wants is not the schema's — see
  // `DEFAULT_SPARKLINE_EMPTY_CELLS`.
  attrs.push(`displayEmptyCellsAs="${g.displayEmptyCellsAs ?? DEFAULT_SPARKLINE_EMPTY_CELLS}"`);
  if (g.markers) {
    attrs.push('markers="1"');
  }
  if (g.high) {
    attrs.push('high="1"');
  }
  if (g.low) {
    attrs.push('low="1"');
  }
  if (g.first) {
    attrs.push('first="1"');
  }
  if (g.last) {
    attrs.push('last="1"');
  }
  if (g.negative) {
    attrs.push('negative="1"');
  }
  if (g.displayXAxis) {
    attrs.push('displayXAxis="1"');
  }
  if (g.displayHidden) {
    attrs.push('displayHidden="1"');
  }
  if (g.minAxisType && g.minAxisType !== "individual") {
    attrs.push(`minAxisType="${g.minAxisType}"`);
  }
  if (g.maxAxisType && g.maxAxisType !== "individual") {
    attrs.push(`maxAxisType="${g.maxAxisType}"`);
  }
  if (g.manualMin !== undefined) {
    attrs.push(`manualMin="${g.manualMin}"`);
  }
  if (g.manualMax !== undefined) {
    attrs.push(`manualMax="${g.manualMax}"`);
  }
  if (g.rightToLeft) {
    attrs.push('rightToLeft="1"');
  }

  const parts: string[] = [];
  parts.push(`<x14:sparklineGroup${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`);

  // All eight colours, in OOXML order, each falling back to what Excel writes — an absent one is a mark Excel
  // does not paint. See `DEFAULT_SPARKLINE_COLORS`.
  for (const [element, field] of SPARKLINE_COLOR_ELEMENTS) {
    parts.push(
      `<x14:${element} ${sparklineColorAttrs(g[field] ?? DEFAULT_SPARKLINE_COLORS[field])}/>`
    );
  }
  if (g.dateAxis) {
    parts.push(`<xm:f>${escapeXml(g.dateAxis)}</xm:f>`);
  }

  // Sparklines
  parts.push("<x14:sparklines>");
  for (const s of g.sparklines) {
    parts.push("<x14:sparkline>");
    parts.push(`<xm:f>${escapeXml(s.dataRef)}</xm:f>`);
    parts.push(`<xm:sqref>${escapeXml(s.cellRef)}</xm:sqref>`);
    parts.push("</x14:sparkline>");
  }
  parts.push("</x14:sparklines>");
  parts.push("</x14:sparklineGroup>");
  return parts.join("");
}

/** The eight colour elements, in the order `CT_SparklineGroup` requires, paired with their model fields. */
const SPARKLINE_COLOR_ELEMENTS = [
  ["colorSeries", "colorSeries"],
  ["colorNegative", "colorNegative"],
  ["colorAxis", "colorAxis"],
  ["colorMarkers", "colorMarkers"],
  ["colorFirst", "colorFirst"],
  ["colorLast", "colorLast"],
  ["colorHigh", "colorHigh"],
  ["colorLow", "colorLow"]
] as const satisfies readonly (readonly [string, keyof typeof DEFAULT_SPARKLINE_COLORS])[];

function sparklineColorAttrs(c: SparklineColor): string {
  const parts: string[] = [];
  if (c.rgb) {
    parts.push(`rgb="${c.rgb}"`);
  }
  if (c.theme !== undefined) {
    parts.push(`theme="${c.theme}"`);
  }
  if (c.tint !== undefined) {
    parts.push(`tint="${c.tint}"`);
  }
  if (c.auto) {
    parts.push('auto="1"');
  }
  return parts.join(" ");
}

function escapeXml(s: string): string {
  // Use the canonical encoder: strips XML 1.0 control characters /
  // lone surrogates and escapes the five reserved entities. The
  // previous manual chain missed `"` / `'` (ok for text, but we
  // share the helper with attribute-less contexts where lone
  // surrogates or bg-copied control codes would corrupt the part).
  return xmlEncode(s);
}

// ============================================================================
// XML parsing (best-effort from raw XML fragment)
// ============================================================================

/**
 * Parse an x14:sparklineGroups XML fragment into structured groups.
 * Best-effort regex-based parser — sufficient for round-trip via rebuild.
 */
export function parseSparklineGroups(xml: string): SparklineGroup[] {
  const groups: SparklineGroup[] = [];
  // Match both the open/close and self-closing forms of
  // `<x14:sparklineGroup ...>`. Excel legitimately emits the
  // self-closing variant (`<x14:sparklineGroup .../>`) when the
  // group has no child elements — e.g. a group whose sole sparkline
  // was deleted but the parent was preserved for styling, or an
  // empty group created programmatically. Requiring an explicit
  // closing tag silently dropped those groups on load, losing the
  // entry on the next write.
  const groupRe = /<x14:sparklineGroup\b([^>]*?)(?:\/>|>([\s\S]*?)<\/x14:sparklineGroup>)/g;
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(xml)) !== null) {
    const g = parseGroupBlock(m[1] ?? "", m[2] ?? "");
    groups.push(g);
  }
  return groups;
}

// Pre-compiled regexes for sparkline color tag parsing
const COLOR_TAG_RES = new Map<string, RegExp>([
  ["colorSeries", /<x14:colorSeries\b([^/]*)\/>/],
  ["colorNegative", /<x14:colorNegative\b([^/]*)\/>/],
  ["colorAxis", /<x14:colorAxis\b([^/]*)\/>/],
  ["colorMarkers", /<x14:colorMarkers\b([^/]*)\/>/],
  ["colorFirst", /<x14:colorFirst\b([^/]*)\/>/],
  ["colorLast", /<x14:colorLast\b([^/]*)\/>/],
  ["colorHigh", /<x14:colorHigh\b([^/]*)\/>/],
  ["colorLow", /<x14:colorLow\b([^/]*)\/>/]
]);

function parseGroupBlock(attrXml: string, inner: string): SparklineGroup {
  const g: SparklineGroup = { sparklines: [] };
  const attrRe = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrXml)) !== null) {
    const [, name, val] = m;
    switch (name) {
      case "type":
        g.type = val as SparklineType;
        break;
      case "lineWeight":
        g.lineWeight = parseFloat(val);
        break;
      case "displayEmptyCellsAs":
        g.displayEmptyCellsAs = val as NonNullable<SparklineGroup["displayEmptyCellsAs"]>;
        break;
      case "markers":
        g.markers = val === "1";
        break;
      case "high":
        g.high = val === "1";
        break;
      case "low":
        g.low = val === "1";
        break;
      case "first":
        g.first = val === "1";
        break;
      case "last":
        g.last = val === "1";
        break;
      case "negative":
        g.negative = val === "1";
        break;
      case "displayXAxis":
        g.displayXAxis = val === "1";
        break;
      case "displayHidden":
        g.displayHidden = val === "1";
        break;
      case "minAxisType":
        g.minAxisType = val as SparklineAxisType;
        break;
      case "maxAxisType":
        g.maxAxisType = val as SparklineAxisType;
        break;
      case "manualMin":
        g.manualMin = parseFloat(val);
        break;
      case "manualMax":
        g.manualMax = parseFloat(val);
        break;
      case "rightToLeft":
        g.rightToLeft = val === "1";
        break;
    }
  }
  // Parse colors
  const colorTags: Array<
    | "colorSeries"
    | "colorNegative"
    | "colorAxis"
    | "colorMarkers"
    | "colorFirst"
    | "colorLast"
    | "colorHigh"
    | "colorLow"
  > = [
    "colorSeries",
    "colorNegative",
    "colorAxis",
    "colorMarkers",
    "colorFirst",
    "colorLast",
    "colorHigh",
    "colorLow"
  ];
  for (const tag of colorTags) {
    const re = COLOR_TAG_RES.get(tag)!;
    const cm = re.exec(inner);
    if (cm) {
      g[tag] = parseColorAttrs(cm[1]);
    }
  }
  // Parse sparklines
  const sparkRe =
    /<x14:sparkline>\s*<xm:f>([\s\S]*?)<\/xm:f>\s*<xm:sqref>([\s\S]*?)<\/xm:sqref>\s*<\/x14:sparkline>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sparkRe.exec(inner)) !== null) {
    g.sparklines.push({
      dataRef: decodeXml(sm[1]),
      cellRef: decodeXml(sm[2])
    });
  }
  return g;
}

function parseColorAttrs(attrXml: string): SparklineColor {
  const c: SparklineColor = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrXml)) !== null) {
    const [, name, val] = m;
    switch (name) {
      case "rgb":
        c.rgb = val;
        break;
      case "theme":
        c.theme = parseInt(val, 10);
        break;
      case "tint":
        c.tint = parseFloat(val);
        break;
      case "auto":
        c.auto = val === "1";
        break;
    }
  }
  return c;
}

function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, m => {
    switch (m) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return m;
    }
  });
}

// =====================================================================
// Geometry (shared by SVG preview and PDF vector rendering)
// =====================================================================

/**
 * A single drawing primitive produced by {@link computeSparklineGeometry}.
 *
 * Coordinates are in a y-DOWN space (SVG convention) within the supplied
 * `width` × `height` box: `(0, 0)` is the top-left corner. The SVG renderer
 * consumes these directly; the PDF bridge flips `y` into its y-up page space.
 * Colours are resolved 6-digit hex strings prefixed with `#`.
 */
export type SparklinePrimitive =
  | { kind: "rect"; x: number; y: number; width: number; height: number; color: string }
  | {
      kind: "polyline";
      points: ReadonlyArray<{ x: number; y: number }>;
      color: string;
      width: number;
    }
  | { kind: "circle"; cx: number; cy: number; r: number; color: string }
  | { kind: "axis"; x1: number; y1: number; x2: number; y2: number; color: string };

/** Geometry options for {@link computeSparklineGeometry}. */
export interface SparklineGeometryOptions {
  /** Box width in px. */
  width: number;
  /** Box height in px. */
  height: number;
  /** Inner padding in px. */
  padding: number;
  /**
   * Axis min/max shared across a group when `minAxisType`/`maxAxisType` is
   * `"group"`. When omitted the row's own finite min/max is used for the
   * `"group"` setting too (single-sparkline preview).
   */
  groupMin?: number;
  groupMax?: number;
}

/**
 * Compute the abstract drawing primitives for one sparkline over `values`
 * within a `width` × `height` box (y-down). This is the single source of truth
 * for sparkline geometry — both the SVG preview ({@link renderSparklineSvg})
 * and the PDF vector bridge consume it, so axis ranging, marker placement and
 * bar/line layout stay identical across outputs.
 */
export function computeSparklineGeometry(
  group: SparklineGroup,
  values: number[],
  options: SparklineGeometryOptions
): SparklinePrimitive[] {
  const out: SparklinePrimitive[] = [];
  const { width, height, padding } = options;

  const lineColor = resolveSparklineColor(group.colorSeries) ?? "#376091";
  const negativeColor = resolveSparklineColor(group.colorNegative) ?? "#D00000";
  const axisColor = resolveSparklineColor(group.colorAxis) ?? "#000000";
  const markerColor = resolveSparklineColor(group.colorMarkers) ?? lineColor;
  const highColor = resolveSparklineColor(group.colorHigh) ?? markerColor;
  const lowColor = resolveSparklineColor(group.colorLow) ?? markerColor;
  const firstColor = resolveSparklineColor(group.colorFirst) ?? markerColor;
  const lastColor = resolveSparklineColor(group.colorLast) ?? markerColor;

  const data = values;
  if (data.length === 0) {
    return out;
  }

  const groupMin = options.groupMin ?? minOrNaN([data]);
  const groupMax = options.groupMax ?? maxOrNaN([data]);
  const { min, max } = axisRangeFor(group, data, groupMin, groupMax);

  const innerX = padding;
  const innerY = padding;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  if (innerW <= 0 || innerH <= 0) {
    return out;
  }

  const span = max === min ? 1 : max - min;
  const rtl = group.rightToLeft === true;
  const xAt = (i: number, n: number): number => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const shifted = rtl ? 1 - t : t;
    return innerX + shifted * innerW;
  };
  const yAt = (v: number): number => {
    if (!Number.isFinite(v)) {
      return innerY + innerH;
    }
    const t = (v - min) / span;
    return innerY + innerH - t * innerH;
  };

  if (group.type === "column" || group.type === "stacked") {
    const n = data.length;
    const barW = Math.max(1, (innerW / Math.max(n, 1)) * 0.8);
    let firstIdx = -1;
    let lastIdx = -1;
    let highIdx = -1;
    let lowIdx = -1;
    let highVal = -Infinity;
    let lowVal = Infinity;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) {
        continue;
      }
      if (firstIdx === -1) {
        firstIdx = i;
      }
      lastIdx = i;
      if (v > highVal) {
        highVal = v;
        highIdx = i;
      }
      if (v < lowVal) {
        lowVal = v;
        lowIdx = i;
      }
    }
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v) || v === 0) {
        continue;
      }
      const centre = xAt(i, n);
      const x = centre - barW / 2;
      let color = v < 0 && group.negative === true ? negativeColor : lineColor;
      if (group.high && i === highIdx) {
        color = highColor;
      }
      if (group.low && i === lowIdx) {
        color = lowColor;
      }
      if (group.first && i === firstIdx) {
        color = firstColor;
      }
      if (group.last && i === lastIdx) {
        color = lastColor;
      }
      let y: number;
      let h: number;
      if (group.type === "stacked") {
        const half = innerH / 2;
        if (v >= 0) {
          y = innerY + half - half;
          h = half;
        } else {
          y = innerY + half;
          h = half;
        }
      } else {
        const base = min <= 0 && max >= 0 ? yAt(0) : innerY + innerH;
        const top = yAt(v);
        y = Math.min(base, top);
        h = Math.abs(base - top);
      }
      out.push({ kind: "rect", x, y, width: barW, height: Math.max(h, 1), color });
    }
  } else {
    // `displayEmptyCellsAs` was serialised into the XML but never read back when
    // drawing, so all three settings produced the same picture: the blanks were dropped
    // and the line ran straight across them. That is `span` — the one Excel does *not*
    // use by default.
    const emptyAs = group.displayEmptyCellsAs ?? "gap";
    const plotted: Array<{ x: number; y: number; v: number } | undefined> = [];
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const x = xAt(i, data.length);
      if (Number.isFinite(v)) {
        plotted.push({ x, y: yAt(v), v });
      } else if (emptyAs === "zero") {
        // A blank reads as a value of zero, so it gets a point like any other.
        plotted.push({ x, y: yAt(0), v: 0 });
      } else {
        // `gap` breaks the line here; `span` bridges it. Either way there is no point.
        plotted.push(undefined);
      }
    }
    const pointsFinite = plotted.filter((p): p is { x: number; y: number; v: number } => !!p);
    // `gap` splits into runs so the break is visible; `span` and `zero` are one run.
    const runs: Array<Array<{ x: number; y: number; v: number }>> =
      emptyAs === "gap"
        ? plotted.reduce<Array<Array<{ x: number; y: number; v: number }>>>((acc, point) => {
            if (!point) {
              if (acc.length > 0 && acc[acc.length - 1].length > 0) {
                acc.push([]);
              }
              return acc;
            }
            if (acc.length === 0) {
              acc.push([]);
            }
            acc[acc.length - 1].push(point);
            return acc;
          }, [])
        : [pointsFinite];
    for (const run of runs) {
      if (run.length >= 2) {
        out.push({
          kind: "polyline",
          points: run.map(p => ({ x: p.x, y: p.y })),
          color: lineColor,
          width: group.lineWeight ? group.lineWeight * 0.75 : 1
        });
      }
    }
    if (group.markers) {
      for (const p of pointsFinite) {
        out.push({ kind: "circle", cx: p.x, cy: p.y, r: 1.5, color: markerColor });
      }
    }
    if (pointsFinite.length > 0) {
      if (group.first) {
        const p = pointsFinite[0];
        out.push({ kind: "circle", cx: p.x, cy: p.y, r: 1.8, color: firstColor });
      }
      if (group.last) {
        const p = pointsFinite[pointsFinite.length - 1];
        out.push({ kind: "circle", cx: p.x, cy: p.y, r: 1.8, color: lastColor });
      }
      if (group.high) {
        const hi = pointsFinite.reduce((acc, p) => (p.v > acc.v ? p : acc), pointsFinite[0]);
        out.push({ kind: "circle", cx: hi.x, cy: hi.y, r: 1.8, color: highColor });
      }
      if (group.low) {
        const lo = pointsFinite.reduce((acc, p) => (p.v < acc.v ? p : acc), pointsFinite[0]);
        out.push({ kind: "circle", cx: lo.x, cy: lo.y, r: 1.8, color: lowColor });
      }
      if (group.negative) {
        for (const p of pointsFinite) {
          if (p.v < 0) {
            out.push({ kind: "circle", cx: p.x, cy: p.y, r: 1.8, color: negativeColor });
          }
        }
      }
    }
  }

  if (group.displayXAxis) {
    let axisY: number | undefined;
    if (group.type === "stacked") {
      axisY = innerY + innerH / 2;
    } else if (min <= 0 && max >= 0) {
      axisY = yAt(0);
    }
    if (axisY !== undefined) {
      out.push({
        kind: "axis",
        x1: innerX,
        y1: axisY,
        x2: innerX + innerW,
        y2: axisY,
        color: axisColor
      });
    }
  }

  return out;
}

// =====================================================================
// SVG rendering
// =====================================================================

/**
 * Options for {@link renderSparklineSvg}.
 */
export interface SparklineRenderOptions {
  /** Output width in px (default 120). */
  width?: number;
  /** Output height in px (default 30). */
  height?: number;
  /** Background fill colour. When absent, the SVG has a transparent background. */
  background?: string;
  /** Inner padding in px so markers don't clip against the SVG edges. */
  padding?: number;
}

/**
 * Render a sparkline group to a single SVG string given explicit data
 * values for each sparkline in the group. This is a preview-grade
 * renderer suitable for PDF/PNG embedding — Excel ultimately renders
 * sparklines natively from the formula references.
 *
 * Why take `values: number[][]` rather than walk the workbook: the
 * caller already has a worksheet in scope when it wants a preview,
 * and decoupling the renderer from the worksheet keeps this module
 * free of upstream dependencies. When no per-sparkline data is
 * supplied the SVG is rendered empty (just the background) so the
 * function never throws.
 *
 * Respects the group's `type` (`line` / `column` / `stacked`),
 * `displayXAxis`, `minAxisType` / `maxAxisType` / `manualMin` /
 * `manualMax`, markers (`markers`, `first`, `last`, `high`, `low`,
 * `negative`), `rightToLeft`, and all structural colours
 * (`colorSeries`, `colorNegative`, `colorAxis`, `colorMarkers`,
 * `colorHigh`, `colorLow`, `colorFirst`, `colorLast`).
 *
 * The individual sparkline's `cellRef` is not consulted — the caller
 * controls layout at a higher level and this function returns a
 * standalone SVG per sparkline when passed a group with a single
 * member, or a grid-stacked SVG when given multiple members.
 */
export function sparklineToDrawList(
  group: SparklineGroup,
  values: number[][],
  options: SparklineRenderOptions = {}
): DrawList {
  const width = Math.max(1, options.width ?? 120);
  const height = Math.max(1, options.height ?? 30);
  const padding = Math.max(0, options.padding ?? 2);
  const rowCount = Math.max(group.sparklines.length, values.length, 1);
  const rowHeight = height / rowCount;

  // Per-group axis range: group means all sparklines share min/max;
  // individual means each uses its own; custom uses manualMin/Max.
  const groupMin = minOrNaN(values);
  const groupMax = maxOrNaN(values);

  const children: DrawNode[] = [];
  for (let row = 0; row < rowCount; row++) {
    const data = values[row] ?? [];
    if (data.length === 0) {
      continue;
    }
    const rowTop = rowHeight * row;
    const primitives = computeSparklineGeometry(group, data, {
      width,
      height: rowHeight,
      padding,
      groupMin,
      groupMax
    });
    // Geometry is box-local (y-down); offset each row by its top.
    for (const primitive of primitives) {
      switch (primitive.kind) {
        case "rect":
          children.push({
            kind: "rect",
            x: primitive.x,
            y: rowTop + primitive.y,
            width: primitive.width,
            height: primitive.height,
            paint: { fill: colourOf(primitive.color) }
          });
          break;
        case "polyline":
          children.push({
            kind: "polyline",
            points: primitive.points.map(point => ({ x: point.x, y: rowTop + point.y })),
            paint: { stroke: colourOf(primitive.color), strokeWidth: primitive.width }
          });
          break;
        case "circle":
          children.push({
            kind: "ellipse",
            cx: primitive.cx,
            cy: rowTop + primitive.cy,
            rx: primitive.r,
            ry: primitive.r,
            paint: { fill: colourOf(primitive.color) }
          });
          break;
        case "axis":
          children.push({
            kind: "line",
            x1: primitive.x1,
            y1: rowTop + primitive.y1,
            x2: primitive.x2,
            y2: rowTop + primitive.y2,
            paint: { stroke: colourOf(primitive.color), strokeWidth: 0.5 }
          });
          break;
      }
    }
  }
  return { width, height, children };
}

/**
 * Parse a sparkline colour token, falling back to black.
 *
 * The geometry layer emits `#rrggbb`; a malformed value must still paint
 * something rather than vanish, which is what an `undefined` fill would do.
 */
function colourOf(token: string): Rgba01 {
  return parseCssColor(token) ?? { r: 0, g: 0, b: 0, a: 1 };
}

export function renderSparklineSvg(
  group: SparklineGroup,
  values: number[][],
  options: SparklineRenderOptions = {}
): string {
  return toSvg(sparklineToDrawList(group, values, options), {
    ...(options.background === undefined ? {} : { background: options.background })
  });
}

function axisRangeFor(
  group: SparklineGroup,
  row: number[],
  groupMin: number,
  groupMax: number
): { min: number; max: number } {
  let min: number;
  let max: number;
  // Track whether each bound came from the caller's explicit `custom`
  // setting. A manual bound must never be padded away by the
  // zero-span fallback below — a user who deliberately set
  // `manualMin === manualMax` (e.g. to highlight deviation from a
  // fixed reference value) would otherwise see their bound silently
  // widened by ±1.
  let minIsManual = false;
  let maxIsManual = false;
  if (group.minAxisType === "group") {
    min = groupMin;
  } else if (group.minAxisType === "custom" && group.manualMin !== undefined) {
    min = group.manualMin;
    minIsManual = true;
  } else {
    min = finiteMin(row);
  }
  if (group.maxAxisType === "group") {
    max = groupMax;
  } else if (group.maxAxisType === "custom" && group.manualMax !== undefined) {
    max = group.manualMax;
    maxIsManual = true;
  } else {
    max = finiteMax(row);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    // Flat line — pad so the point renders in the middle. Only apply
    // the pad when neither bound was manually authored; otherwise the
    // user's explicit choice wins and the sparkline renders as a
    // single point at mid-height (which is what the bound requested).
    if (minIsManual || maxIsManual) {
      return { min, max };
    }
    return { min: min - 1, max: max + 1 };
  }
  return { min, max };
}

function finiteMin(row: number[]): number {
  let r = Infinity;
  for (const v of row) {
    if (Number.isFinite(v) && v < r) {
      r = v;
    }
  }
  return r;
}
function finiteMax(row: number[]): number {
  let r = -Infinity;
  for (const v of row) {
    if (Number.isFinite(v) && v > r) {
      r = v;
    }
  }
  return r;
}
function minOrNaN(rows: number[][]): number {
  let r = Infinity;
  for (const row of rows) {
    const m = finiteMin(row);
    if (m < r) {
      r = m;
    }
  }
  return Number.isFinite(r) ? r : NaN;
}
function maxOrNaN(rows: number[][]): number {
  let r = -Infinity;
  for (const row of rows) {
    const m = finiteMax(row);
    if (m > r) {
      r = m;
    }
  }
  return Number.isFinite(r) ? r : NaN;
}

function resolveSparklineColor(color: SparklineColor | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  if (color.rgb) {
    // Excel sparkline RGB hex is ARGB (8 chars) or RGB (6 chars); we
    // normalise to a 6-char hex for SVG consumption, discarding alpha.
    const hex = color.rgb.length === 8 ? color.rgb.slice(2) : color.rgb;
    return `#${hex}`;
  }
  // Theme colours require the workbook theme to resolve precisely; for
  // preview purposes fall back to a stable palette that roughly tracks
  // Office defaults. Callers who need pixel-perfect theme resolution
  // can supply a structured `rgb` instead.
  if (color.theme !== undefined) {
    const hex = CHART_THEME_PALETTE[color.theme];
    return hex ? `#${hex}` : "#000000";
  }
  return undefined;
}
