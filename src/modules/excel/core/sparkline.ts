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

import { CHART_THEME_PALETTE } from "@utils/theme-colors";
import { xmlEncode, xmlEncodeAttr } from "@xml/encode";

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
  if (g.displayEmptyCellsAs) {
    attrs.push(`displayEmptyCellsAs="${g.displayEmptyCellsAs}"`);
  }
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

  // Colors (emit only those set, in OOXML order)
  if (g.colorSeries) {
    parts.push(`<x14:colorSeries ${sparklineColorAttrs(g.colorSeries)}/>`);
  }
  if (g.colorNegative) {
    parts.push(`<x14:colorNegative ${sparklineColorAttrs(g.colorNegative)}/>`);
  }
  if (g.colorAxis) {
    parts.push(`<x14:colorAxis ${sparklineColorAttrs(g.colorAxis)}/>`);
  }
  if (g.colorMarkers) {
    parts.push(`<x14:colorMarkers ${sparklineColorAttrs(g.colorMarkers)}/>`);
  }
  if (g.colorFirst) {
    parts.push(`<x14:colorFirst ${sparklineColorAttrs(g.colorFirst)}/>`);
  }
  if (g.colorLast) {
    parts.push(`<x14:colorLast ${sparklineColorAttrs(g.colorLast)}/>`);
  }
  if (g.colorHigh) {
    parts.push(`<x14:colorHigh ${sparklineColorAttrs(g.colorHigh)}/>`);
  }
  if (g.colorLow) {
    parts.push(`<x14:colorLow ${sparklineColorAttrs(g.colorLow)}/>`);
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
    const pointsFinite: Array<{ x: number; y: number; v: number }> = [];
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) {
        pointsFinite.push({ x: xAt(i, data.length), y: yAt(v), v });
      }
    }
    if (pointsFinite.length >= 2) {
      out.push({
        kind: "polyline",
        points: pointsFinite.map(p => ({ x: p.x, y: p.y })),
        color: lineColor,
        width: group.lineWeight ? group.lineWeight * 0.75 : 1
      });
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
export function renderSparklineSvg(
  group: SparklineGroup,
  values: number[][],
  options: SparklineRenderOptions = {}
): string {
  const width = Math.max(1, options.width ?? 120);
  const height = Math.max(1, options.height ?? 30);
  const padding = Math.max(0, options.padding ?? 2);
  const rowCount = Math.max(group.sparklines.length, values.length, 1);
  const rowHeight = height / rowCount;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  if (options.background) {
    parts.push(
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeAttr(options.background)}"/>`
    );
  }

  // Per-group axis range: group means all sparklines share min/max;
  // individual means each uses its own; custom uses manualMin/Max.
  const groupMin = minOrNaN(values);
  const groupMax = maxOrNaN(values);

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
    for (const p of primitives) {
      switch (p.kind) {
        case "rect":
          parts.push(
            `<rect x="${p.x}" y="${rowTop + p.y}" width="${p.width}" height="${p.height}" fill="${p.color}"/>`
          );
          break;
        case "polyline": {
          const d = p.points
            .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x} ${rowTop + pt.y}`)
            .join(" ");
          parts.push(`<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${p.width}"/>`);
          break;
        }
        case "circle":
          parts.push(`<circle cx="${p.cx}" cy="${rowTop + p.cy}" r="${p.r}" fill="${p.color}"/>`);
          break;
        case "axis":
          parts.push(
            `<line x1="${p.x1}" y1="${rowTop + p.y1}" x2="${p.x2}" y2="${rowTop + p.y2}" stroke="${p.color}" stroke-width="0.5"/>`
          );
          break;
      }
    }
  }

  parts.push(`</svg>`);
  return parts.join("");
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

function escapeAttr(s: string): string {
  // Attribute values additionally require `\t \n \r` → numeric refs
  // so XML attribute-value normalisation doesn't collapse them to
  // literal spaces (losing e.g. a manual cell-reference break in a
  // sparkline group's `manualMin` / `manualMax` display label).
  return xmlEncodeAttr(s);
}
