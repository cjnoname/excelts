/**
 * ChartEx layouts → {@link DrawList}.
 *
 * ## Why this exists
 *
 * Every ChartEx layout used to be written twice: once emitting SVG strings and
 * once issuing PDF drawing calls, roughly 1,370 lines paired function for
 * function. Two renderers over one model is how they drifted — the title came out
 * 16pt at y=20 in PDF and 18pt at y=26 in SVG, the plot rectangle differed
 * entirely for a chart with no legend, and neither of those was visible from
 * either side alone.
 *
 * Converting once removes the second reading. This file is the only place that
 * knows what a ChartEx layout *looks* like; `renderDrawList` walks it; each
 * surface only puts marks down.
 *
 * ## Fidelity
 *
 * Emission order and geometry are preserved exactly, and
 * `chart-ex-baseline.test.ts` checks that: geometry hashes for SVG, recorded
 * drawing calls for PDF, plus a cross-backend assertion that derives the expected
 * PDF coordinates from the SVG output and the Y flip, so the two cannot drift
 * apart again without a failure.
 */

import { cssColour, translucent } from "@draw/colour";
import { rectNode } from "@draw/types";
import type { DrawNode, DrawPaint, DrawPoint } from "@draw/types";
import { COLORS, formatNumber, valueToY } from "@excel/chart/shared/chart-utils";
import type { ChartRect } from "@excel/chart/shared/chart-utils";

/**
 * A rectangle in the chart's own Y-down user space.
 *
 * The shared {@link ChartRect}, not a third structurally identical copy of it: the
 * classic renderer, this file and the ChartEx renderer each had their own name for
 * `{x, y, width, height}`, which cost a mental translation at every boundary and
 * bought nothing.
 */
export type ChartExRect = ChartRect;

/** Opaque black, the fallback for an unparseable colour token. */
/** Axis and gridline colours, matching the classic renderer. */
const GRID = "#D9D9D9";
const AXIS = "#444";
const LABEL = "#555";
const WHITE = "#fff";

/** A filled shape. */
function fill(token: string): DrawPaint {
  return { fill: cssColour(token) };
}

/** A filled shape with a white separator stroke, as every ChartEx layout uses. */
function fillOutlined(token: string): DrawPaint {
  return { fill: cssColour(token), stroke: cssColour(WHITE), strokeWidth: 1 };
}

/** A stroke-only paint. */
function stroke(token: string, width = 1): DrawPaint {
  return { stroke: cssColour(token), strokeWidth: width };
}

/** A two-point line node. */
export function lineNode(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  paint: DrawPaint
): DrawNode {
  return {
    kind: "polyline",
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y2 }
    ],
    paint
  };
}

/** A single-line text node. */
export function textNode(
  x: number,
  y: number,
  text: string,
  size: number,
  colour: string,
  anchor: "start" | "middle" | "end"
): DrawNode {
  return {
    kind: "text",
    x,
    y,
    lines: [{ text, dy: 0 }],
    style: { size, fill: cssColour(colour), anchor, family: "Arial" }
  };
}

/** A closed polygon node. */
export function polygonNode(points: readonly DrawPoint[], paint: DrawPaint): DrawNode {
  return { kind: "polyline", points, closed: true, paint };
}

/**
 * Four interior gridlines with a value label each, plus the baseline and
 * left-frame strokes and their own labels.
 *
 * Both backends read this one function, so a tick can no longer appear on one
 * side and not the other.
 */
export function axesNodes(plot: ChartExRect, range: { min: number; max: number }): DrawNode[] {
  const nodes: DrawNode[] = [];
  for (let i = 1; i < 5; i++) {
    const t = i / 5;
    const y = plot.y + plot.height * t;
    nodes.push(lineNode(plot.x, y, plot.x + plot.width, y, stroke(GRID)));
    const value = range.max + (range.min - range.max) * t;
    nodes.push(textNode(plot.x - 8, y + 3, formatNumber(value), 10, LABEL, "end"));
  }
  nodes.push(
    lineNode(plot.x, plot.y + plot.height, plot.x + plot.width, plot.y + plot.height, stroke(AXIS))
  );
  nodes.push(lineNode(plot.x, plot.y, plot.x, plot.y + plot.height, stroke(AXIS)));
  for (const bound of [range.max, range.min]) {
    nodes.push(
      textNode(
        plot.x - 8,
        valueToY(bound, range.min, range.max, plot) + 3,
        formatNumber(bound),
        10,
        LABEL,
        "end"
      )
    );
  }
  return nodes;
}

/** Clustered columns with a category label under each. */
export function columnNodes(
  values: number[],
  categories: string[],
  plot: ChartExRect,
  colour: string,
  range: { min: number; max: number }
): DrawNode[] {
  const nodes: DrawNode[] = [...axesNodes(plot, range)];
  const count = Math.max(1, values.length);
  const groupWidth = plot.width / count;
  const zero = valueToY(0, range.min, range.max, plot);
  values.forEach((value, index) => {
    const y = valueToY(value, range.min, range.max, plot);
    nodes.push(
      rectNode(
        {
          x: plot.x + index * groupWidth + groupWidth * 0.18,
          y: Math.min(y, zero),
          width: groupWidth * 0.64,
          height: Math.abs(zero - y)
        },
        fill(colour)
      )
    );
    nodes.push(
      textNode(
        plot.x + index * groupWidth + groupWidth / 2,
        plot.y + plot.height + 18,
        categories[index] ?? String(index + 1),
        10,
        LABEL,
        "middle"
      )
    );
  });
  return nodes;
}

/** Treemap cells with an inset label. */
export function treemapNodes(
  cells: readonly { rect: ChartExRect; color: string; label?: string }[]
): DrawNode[] {
  const nodes: DrawNode[] = [];
  for (const cell of cells) {
    nodes.push(rectNode(cell.rect, fillOutlined(cell.color)));
    if (cell.label) {
      nodes.push(textNode(cell.rect.x + 4, cell.rect.y + 14, cell.label, 10, WHITE, "start"));
    }
  }
  return nodes;
}

/**
 * An annular sector.
 *
 * A first-class `sector` node rather than a lowered path: SVG keeps its native
 * arc, the PDF adapter lowers to cubics, and the rasteriser tests radius and
 * angle per pixel for an exact edge.
 */
export function ringNode(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
  colour: string
): DrawNode {
  return {
    kind: "sector",
    cx,
    cy,
    radius: outer,
    innerRadius: inner,
    startAngle: start,
    endAngle: end,
    paint: fillOutlined(colour)
  };
}

/** Sunburst ring slices. */
export function sunburstNodes(
  slices: readonly {
    cx: number;
    cy: number;
    outer: number;
    inner: number;
    start: number;
    end: number;
    color: string;
  }[]
): DrawNode[] {
  return slices.map(slice =>
    ringNode(slice.cx, slice.cy, slice.outer, slice.inner, slice.start, slice.end, slice.color)
  );
}

/**
 * Funnel stages: a trapezoid per value, tapering towards the next one.
 *
 * Non-finite values contribute zero width rather than propagating NaN into the
 * vertices, which would collapse a stage onto the page origin.
 */
export function funnelNodes(
  values: number[],
  plot: ChartExRect,
  colourOf: (index: number) => string,
  labelOf: (index: number, value: number) => string | undefined
): DrawNode[] {
  const trueMax = values.reduce(
    (max, value) => (Number.isFinite(value) ? Math.max(max, Math.abs(value)) : max),
    0
  );
  const max = trueMax > 0 ? trueMax : 1;
  const count = Math.max(1, values.length);
  const h = plot.height / count;
  const nodes: DrawNode[] = [];
  values.forEach((value, index) => {
    const absValue = Number.isFinite(value) ? Math.abs(value) : 0;
    const rawNext = values[index + 1];
    const nextAbs = Number.isFinite(rawNext) ? Math.abs(rawNext) : absValue;
    const topW = (absValue / max) * plot.width;
    const bottomW = (nextAbs / max) * plot.width;
    const y = plot.y + index * h;
    const cx = plot.x + plot.width / 2;
    nodes.push(
      polygonNode(
        [
          { x: cx - topW / 2, y },
          { x: cx + topW / 2, y },
          { x: cx + bottomW / 2, y: y + h * 0.88 },
          { x: cx - bottomW / 2, y: y + h * 0.88 }
        ],
        fillOutlined(colourOf(index))
      )
    );
    const label = labelOf(index, value);
    if (label !== undefined) {
      nodes.push(textNode(cx, y + h * 0.55, label, 11, WHITE, "middle"));
    }
  });
  return nodes;
}

/** Re-exported so the layouts can share one palette lookup. */
export function paletteColour(index: number): string {
  return COLORS[index % COLORS.length];
}

/** One resolved waterfall column. */
export interface WaterfallSpan {
  readonly start: number;
  readonly end: number;
  readonly colour: string;
  /** Gap rows render invisibly rather than as a one-pixel sliver. */
  readonly gap: boolean;
}

/**
 * Waterfall columns, their category labels, and the dashed connectors between
 * consecutive tops.
 */
export function waterfallNodes(
  spans: readonly WaterfallSpan[],
  categories: readonly string[],
  plot: ChartExRect,
  range: { min: number; max: number }
): DrawNode[] {
  const nodes: DrawNode[] = [...axesNodes(plot, range)];
  const count = Math.max(1, spans.length);
  const groupWidth = plot.width / count;
  const barWidth = groupWidth * 0.64;

  spans.forEach((span, index) => {
    const y1 = valueToY(span.start, range.min, range.max, plot);
    const y2 = valueToY(span.end, range.min, range.max, plot);
    const x = plot.x + index * groupWidth + groupWidth * 0.18;
    // A flat span must not be floored to 1px: that reads as a tiny positive delta
    // rather than the blank row it is.
    const height = span.gap ? 0 : Math.max(1, Math.abs(y1 - y2));
    nodes.push(rectNode({ x, y: Math.min(y1, y2), width: barWidth, height }, fill(span.colour)));
    nodes.push(
      textNode(
        plot.x + index * groupWidth + groupWidth / 2,
        plot.y + plot.height + 18,
        categories[index] ?? String(index + 1),
        10,
        LABEL,
        "middle"
      )
    );
  });
  return nodes;
}

/** Dashed connectors joining consecutive waterfall column tops. */
export function waterfallConnectorNodes(
  spans: readonly WaterfallSpan[],
  plot: ChartExRect,
  range: { min: number; max: number }
): DrawNode[] {
  const count = Math.max(1, spans.length);
  const groupWidth = plot.width / count;
  const barWidth = groupWidth * 0.64;
  const tops = spans.map((span, index) => ({
    x: plot.x + index * groupWidth + groupWidth * 0.18 + barWidth,
    y: valueToY(span.end, range.min, range.max, plot)
  }));
  const nodes: DrawNode[] = [];
  for (let index = 0; index < tops.length - 1; index++) {
    nodes.push(
      lineNode(tops[index].x, tops[index].y, tops[index + 1].x - barWidth, tops[index].y, {
        stroke: cssColour("#888"),
        strokeWidth: 1,
        dash: [3, 3]
      })
    );
  }
  return nodes;
}

/**
 * The Pareto cumulative overlay: a polyline through the running percentage, a
 * marker at each step, and the caption.
 *
 * The caption is emitted whenever the line is, matching both backends. It used to
 * be gated on `layoutPr.paretoLine`, which the standalone `paretoLine` layout does
 * not set — so that variant drew the line with no caption in SVG while PDF drew
 * both.
 */
export function paretoOverlayNodes(sortedValues: readonly number[], plot: ChartExRect): DrawNode[] {
  // Non-finite slots contribute nothing. `Math.max(0, NaN)` is `NaN`, and a single
  // blank cell used to suppress the whole overlay.
  const total = sortedValues.reduce(
    (sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0),
    0
  );
  if (!(total > 0)) {
    return [];
  }
  const count = Math.max(1, sortedValues.length);
  const step = plot.width / count;
  let cumulative = 0;
  const points: DrawPoint[] = sortedValues.map((value, index) => {
    cumulative += Number.isFinite(value) ? Math.max(0, value) : 0;
    return {
      x: plot.x + index * step + step / 2,
      y: plot.y + plot.height - (cumulative / total) * plot.height
    };
  });
  const colour = paletteColour(1);
  const nodes: DrawNode[] = [
    { kind: "polyline", points, paint: stroke(colour, 2) },
    ...points.map((point): DrawNode => ({
      kind: "ellipse",
      cx: point.x,
      cy: point.y,
      rx: 3,
      ry: 3,
      paint: fill(colour)
    })),
    textNode(plot.x + plot.width - 4, plot.y + 12, "Cumulative %", 10, colour, "end")
  ];
  return nodes;
}

/** Statistics for one box-and-whisker group. */
export interface BoxStats {
  readonly q1: number;
  readonly q3: number;
  readonly median: number;
  readonly low: number;
  readonly high: number;
  readonly mean: number;
  readonly nonOutliers: readonly number[];
  readonly outliers: readonly number[];
}

/** Which optional box-plot decorations to draw. */
export interface BoxOptions {
  readonly showMeanMarker: boolean;
  readonly showMeanLine: boolean;
  readonly showInnerPoints: boolean;
  readonly showOutlierPoints: boolean;
}

/** One box-and-whisker group: whisker, box, median, and the optional extras. */
export function boxWhiskerNodes(
  groups: readonly { key: string; stats: BoxStats }[],
  plot: ChartExRect,
  range: { min: number; max: number },
  options: BoxOptions
): DrawNode[] {
  const nodes: DrawNode[] = [...axesNodes(plot, range)];
  const groupWidth = plot.width / Math.max(1, groups.length);
  const at = (value: number): number => valueToY(value, range.min, range.max, plot);

  groups.forEach(({ key, stats }, index) => {
    const cx = plot.x + index * groupWidth + groupWidth / 2;
    const w = groupWidth * 0.38;
    const colour = paletteColour(index);
    const q1 = at(stats.q1);
    const q3 = at(stats.q3);

    nodes.push(lineNode(cx, at(stats.high), cx, at(stats.low), stroke(LABEL)));
    nodes.push(
      rectNode(
        { x: cx - w / 2, y: Math.min(q1, q3), width: w, height: Math.abs(q3 - q1) },
        { fill: translucent(colour, 0.35), stroke: cssColour(colour), strokeWidth: 1 }
      )
    );
    const median = at(stats.median);
    nodes.push(lineNode(cx - w / 2, median, cx + w / 2, median, stroke("#333")));

    if (options.showMeanMarker) {
      nodes.push({
        kind: "ellipse",
        cx,
        cy: at(stats.mean),
        rx: 3,
        ry: 3,
        paint: fill("#333")
      });
    }
    if (options.showMeanLine) {
      const mean = at(stats.mean);
      nodes.push(
        lineNode(cx - w / 2, mean, cx + w / 2, mean, {
          stroke: cssColour("#333"),
          strokeWidth: 1,
          dash: [3, 2]
        })
      );
    }
    if (options.showInnerPoints) {
      // Only the non-outliers: iterating the raw group would paint an outlier
      // twice, once filled and once as a hollow ring, when both flags are on.
      for (const value of stats.nonOutliers) {
        nodes.push({
          kind: "ellipse",
          cx: cx - w * 0.62,
          cy: at(value),
          rx: 1.6,
          ry: 1.6,
          paint: { fill: translucent(colour, 0.55) }
        });
      }
    }
    if (options.showOutlierPoints) {
      for (const outlier of stats.outliers) {
        nodes.push({
          kind: "ellipse",
          cx: cx + w * 0.62,
          cy: at(outlier),
          rx: 2,
          ry: 2,
          paint: stroke("#333")
        });
      }
    }
    nodes.push(textNode(cx, plot.y + plot.height + 18, key, 10, LABEL, "middle"));
  });
  return nodes;
}

/** The six corners of a flat-topped hexagon. */
export function hexagonPoints(cx: number, cy: number, radius: number): DrawPoint[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = Math.PI / 6 + (Math.PI * 2 * index) / 6;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

/**
 * A text node stacking several paragraphs from one origin.
 *
 * The step is absolute rather than a relative `em`, so no consumer has to resolve
 * a unit against a font size to know where a line sits — the same convention the
 * classic renderer uses.
 */
export function multilineTextNode(
  x: number,
  y: number,
  texts: readonly string[],
  size: number,
  colour: string,
  anchor: "start" | "middle" | "end",
  lineHeight: number
): DrawNode {
  return {
    kind: "text",
    x,
    y,
    lines: texts.map((text, index) => ({ text, dy: index * lineHeight })),
    style: { size, fill: cssColour(colour), anchor, family: "Arial" }
  };
}
