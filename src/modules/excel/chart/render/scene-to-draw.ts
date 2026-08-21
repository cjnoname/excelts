/**
 * `ChartScene` → {@link DrawList}.
 *
 * ## Why this exists
 *
 * The chart scene used to be walked twice — once by a ~420-line SVG string
 * emitter and once by a ~680-line PDF emitter — with the Node rasteriser
 * re-parsing the SVG the first one had just produced. Three readings of one
 * scene, each with its own idea of what an attribute meant, is what let the
 * backends drift apart: dashes vanished in the raster, opacity was dropped,
 * rotations mirrored in PDF, and the pie fast path had to smuggle its geometry
 * through a `data-sector` attribute so the rasteriser could recover it.
 *
 * Converting once removes all of that. This file is the only place that knows how
 * a chart scene *looks*; `renderDrawList` is the only place that knows how to
 * walk it; each surface only knows how to put marks down.
 *
 * ## Fidelity
 *
 * Emission order is preserved exactly, including the two-pass split that paints
 * every series' shapes before any series' adornments — a single pass let a later
 * series' filled area cover an earlier one's data labels. The geometry baselines
 * in `chart-geometry-baseline.test.ts` compare the *normalised geometry* of the
 * output, so a representational change (a `<polyline>` where a `<path>` used to
 * be) passes while a moved coordinate does not.
 */

import { cssColour, translucent } from "@draw/colour";
import { rectNode } from "@draw/types";
import type {
  DrawList,
  DrawNode,
  DrawPaint,
  DrawPathCommand,
  DrawPoint,
  DrawTextStyle
} from "@draw/types";
import type {
  ChartScene,
  ChartSceneAdornment,
  ChartSceneDataTable,
  ChartSceneLegend,
  ChartSceneLine,
  ChartSceneMarker,
  ChartScenePieSlice,
  ChartScenePoint,
  ChartSceneRect,
  ChartSceneSeries,
  ChartSceneText
} from "@excel/chart/render/chart-renderer";
import {
  GRID_COLOR,
  estimateTextWidth,
  splitTextLines,
  withAlpha
} from "@excel/chart/shared/chart-utils";

/** Opaque black, the fallback for an unparseable colour token. */
/** Convert a scene text node to its display-list equivalent. */
function textNode(text: ChartSceneText): DrawNode {
  const style: DrawTextStyle = {
    size: text.fontSize,
    fill: cssColour(text.color),
    anchor: text.anchor ?? "start",
    family: text.fontFamily ?? "Arial",
    ...(text.bold ? { bold: true } : {}),
    ...(text.italic ? { italic: true } : {})
  };
  // Paragraph breaks are stacked at 1.2 em, the factor every backend shares.
  const lines = splitTextLines(text.text).map(line => ({
    text: line.text,
    dy: line.index * 1.2 * text.fontSize
  }));
  return {
    kind: "text",
    x: text.x,
    y: text.y,
    lines,
    style,
    ...(text.rotate ? { rotate: text.rotate } : {})
  };
}

/** Convert a scene line to a two-point polyline. */
function lineNode(line: ChartSceneLine): DrawNode {
  return {
    kind: "polyline",
    points: [
      { x: line.x1, y: line.y1 },
      { x: line.x2, y: line.y2 }
    ],
    paint: { stroke: cssColour(line.color), strokeWidth: line.width ?? 1 }
  };
}

/**
 * Split points into contiguous runs of finite coordinates.
 *
 * A non-finite coordinate marks a blank or `#N/A` source cell. Breaking the run
 * there is Excel's default `dispBlanksAs="gap"`; joining through it would draw a
 * spike to the origin.
 */
function finiteRuns(points: readonly ChartScenePoint[]): ChartScenePoint[][] {
  const runs: ChartScenePoint[][] = [];
  let current: ChartScenePoint[] = [];
  for (const point of points) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      current.push(point);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/** A pie/doughnut slice. */
function sliceNode(slice: ChartScenePieSlice): DrawNode {
  return {
    kind: "sector",
    cx: slice.cx,
    cy: slice.cy,
    radius: slice.radius,
    innerRadius: slice.innerRadius,
    startAngle: slice.startAngle,
    endAngle: slice.endAngle,
    paint: { fill: cssColour(slice.color) }
  };
}

/**
 * Extrude a bar into three visible faces.
 *
 * Top and right are parallelograms along the projection vector, shaded by mixing
 * the series colour towards white so the axonometric read is legible without a
 * lighting model. The back face is hidden behind the front rect by definition.
 */
function bar3DNodes(
  bar: ChartSceneRect,
  projection: { dx: number; dy: number },
  color: string
): DrawNode[] {
  const right = bar.x + bar.width;
  const top = bar.y;
  const bottom = bar.y + bar.height;
  const { dx, dy } = projection;
  // Mixed towards white rather than made translucent: this is a lighting cue, so
  // the background must not show through the face.
  const paint = (mix: number): DrawPaint => ({ fill: cssColour(withAlpha(color, mix)) });
  return [
    {
      kind: "polyline",
      closed: true,
      points: [
        { x: bar.x, y: top },
        { x: bar.x + dx, y: top - dy },
        { x: right + dx, y: top - dy },
        { x: right, y: top }
      ],
      paint: paint(0.92)
    },
    {
      kind: "polyline",
      closed: true,
      points: [
        { x: right, y: top },
        { x: right + dx, y: top - dy },
        { x: right + dx, y: bottom - dy },
        { x: right, y: bottom }
      ],
      paint: paint(0.75)
    },
    rectNode(bar, { fill: cssColour(color) })
  ];
}

/** A marker glyph. */
function markerNodes(marker: ChartSceneMarker): DrawNode[] {
  const r = marker.size / 2;
  const fill: DrawPaint = { fill: cssColour(marker.color) };
  const stroke: DrawPaint = { stroke: cssColour(marker.color), strokeWidth: 2 };
  switch (marker.symbol) {
    case "square":
      return [
        rectNode(
          { x: marker.x - r, y: marker.y - r, width: marker.size, height: marker.size },
          fill
        )
      ];
    case "diamond":
      return [
        {
          kind: "polyline",
          closed: true,
          points: [
            { x: marker.x, y: marker.y - r },
            { x: marker.x + r, y: marker.y },
            { x: marker.x, y: marker.y + r },
            { x: marker.x - r, y: marker.y }
          ],
          paint: fill
        }
      ];
    case "triangle":
      return [
        {
          kind: "polyline",
          closed: true,
          points: [
            { x: marker.x, y: marker.y - r },
            { x: marker.x + r, y: marker.y + r },
            { x: marker.x - r, y: marker.y + r }
          ],
          paint: fill
        }
      ];
    case "x":
      return [
        {
          kind: "polyline",
          points: [
            { x: marker.x - r, y: marker.y - r },
            { x: marker.x + r, y: marker.y + r }
          ],
          paint: stroke
        },
        {
          kind: "polyline",
          points: [
            { x: marker.x + r, y: marker.y - r },
            { x: marker.x - r, y: marker.y + r }
          ],
          paint: stroke
        }
      ];
    case "plus":
      return [
        {
          kind: "polyline",
          points: [
            { x: marker.x - r, y: marker.y },
            { x: marker.x + r, y: marker.y }
          ],
          paint: stroke
        },
        {
          kind: "polyline",
          points: [
            { x: marker.x, y: marker.y - r },
            { x: marker.x, y: marker.y + r }
          ],
          paint: stroke
        }
      ];
    default:
      return [{ kind: "ellipse", cx: marker.x, cy: marker.y, rx: r, ry: r, paint: fill }];
  }
}

/** The primary shapes of one series, excluding its adornments. */
function seriesShapes(series: ChartSceneSeries): DrawNode[] {
  const nodes: DrawNode[] = [];
  switch (series.type) {
    case "bar":
      for (const bar of series.bars) {
        if (series.depth && series.projection3D) {
          nodes.push(...bar3DNodes(bar, series.projection3D, series.color));
        } else {
          nodes.push(rectNode(bar, { fill: cssColour(series.color) }));
        }
      }
      return nodes;

    case "area": {
      const lowerSource =
        series.lowerPoints ?? series.points.map(point => ({ x: point.x, y: series.baselineY }));
      for (const run of finiteRuns(series.points)) {
        if (run.length < 2) {
          continue;
        }
        // Close the fill with the matching slice of the lower boundary so a
        // stacked area stays sealed across gaps in the upper edge.
        const startX = run[0].x;
        const endX = run[run.length - 1].x;
        const lower = lowerSource.filter(point => point.x >= startX && point.x <= endX);
        if (lower.length === 0) {
          continue;
        }
        nodes.push({
          kind: "polyline",
          closed: true,
          points: [...run, ...lower.slice().reverse()],
          paint: { fill: translucent(series.color, 0.35) }
        });
        nodes.push({
          kind: "polyline",
          points: run,
          paint: { stroke: cssColour(series.color), strokeWidth: 2 }
        });
      }
      return nodes;
    }

    case "line":
    case "scatter": {
      if (series.showLine !== false) {
        const paint: DrawPaint = {
          stroke: cssColour(series.color),
          strokeWidth: 2,
          // Round joins and caps suit a curve, and are what the old SVG emitter used to
          // stand in for one.
          ...(series.smooth ? { lineJoin: "round" as const, lineCap: "round" as const } : {})
        };
        for (const run of finiteRuns(series.points)) {
          if (run.length < 2) {
            continue;
          }
          // `c:smooth` asks for a spline *through* the points, not a polyline with its
          // corners rounded off. Rounding the joins left the line straight between every
          // pair of points, which is the shape a reader is being told it is not.
          nodes.push(
            series.smooth && run.length > 2
              ? { kind: "path", commands: catmullRomPath(run), paint }
              : { kind: "polyline", points: run, paint }
          );
        }
      }
      for (const point of series.points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          continue;
        }
        nodes.push({
          kind: "ellipse",
          cx: point.x,
          cy: point.y,
          rx: 3,
          ry: 3,
          paint: { fill: cssColour(series.color) }
        });
      }
      return nodes;
    }

    case "bubble":
      for (const bubble of series.bubbles) {
        nodes.push({
          kind: "ellipse",
          cx: bubble.x,
          cy: bubble.y,
          rx: bubble.radius,
          ry: bubble.radius,
          paint: {
            fill: translucent(series.color, 0.55),
            stroke: cssColour(series.color),
            strokeWidth: 1
          }
        });
      }
      return nodes;

    case "pie":
    case "doughnut":
      return series.slices.map(sliceNode);

    case "ofPie":
      return [
        ...series.slices.map(sliceNode),
        ...(series.connectors ?? []).map(lineNode),
        ...(series.secondarySlices ?? []).map(sliceNode)
      ];

    case "radar": {
      nodes.push({
        kind: "ellipse",
        cx: series.center.x,
        cy: series.center.y,
        rx: series.radius,
        ry: series.radius,
        paint: { stroke: cssColour(GRID_COLOR), strokeWidth: 1 }
      });
      const runs = finiteRuns(series.points);
      const fill = series.filled ? translucent(series.color, 0.35) : undefined;
      // A gap-free series stays one closed ring so its fill is a real surface;
      // any gap degrades to open runs, matching Excel's broken-ring behaviour.
      const unbroken = runs.length === 1 && runs[0].length === series.points.length;
      for (const run of runs) {
        if (!unbroken && run.length < 2) {
          continue;
        }
        nodes.push({
          kind: "polyline",
          points: run,
          ...(unbroken ? { closed: true } : {}),
          paint: {
            ...(fill ? { fill } : {}),
            stroke: cssColour(series.color),
            strokeWidth: 2
          }
        });
      }
      return nodes;
    }

    case "stock":
      for (const candle of series.candles) {
        nodes.push({
          kind: "polyline",
          points: [
            { x: candle.x, y: candle.highY },
            { x: candle.x, y: candle.lowY }
          ],
          paint: { stroke: cssColour("#555"), strokeWidth: 1 }
        });
        // A body needs both endpoints. Falling back to one of them collapses it to
        // a 1px strip that reads as a real candle but is an artefact.
        if (candle.openY !== undefined && candle.closeY !== undefined) {
          nodes.push(
            rectNode(
              {
                x: candle.x - candle.width / 2,
                y: Math.min(candle.openY, candle.closeY),
                width: candle.width,
                height: Math.max(1, Math.abs(candle.closeY - candle.openY))
              },
              {
                fill: cssColour(candle.up ? "#70AD47" : "#C00000"),
                stroke: cssColour("#555"),
                strokeWidth: 1
              }
            )
          );
        }
      }
      return nodes;

    case "surface":
      for (const cell of series.cells) {
        nodes.push(
          // A wireframe surface outlines each cell; a shaded one does not. That used
          // to be written as a zero-width stroke in the cell's own colour, which is a
          // roundabout way of saying "no outline" and left each backend to decide what
          // a zero width meant — the rasteriser floored it to a pixel and PDF's `0 w`
          // asks for the device's thinnest line, so both drew an edge SVG did not.
          rectNode(
            cell,
            series.wireframe
              ? { fill: cssColour(cell.color), stroke: cssColour("#555"), strokeWidth: 1 }
              : { fill: cssColour(cell.color) }
          )
        );
      }
      return nodes;
  }
}

/** Error bars, trendlines, markers, leader lines and data labels. */
function adornmentNodes(series: ChartSceneAdornment): DrawNode[] {
  const nodes: DrawNode[] = [];
  for (const bar of series.errorBars ?? []) {
    nodes.push(lineNode(bar.line));
    if (bar.cap1) {
      nodes.push(lineNode(bar.cap1));
    }
    if (bar.cap2) {
      nodes.push(lineNode(bar.cap2));
    }
  }
  for (const trendline of series.trendlines ?? []) {
    // A moving average legitimately emits non-finite values before its window
    // fills, so the runs have to break there like any other series.
    for (const run of finiteRuns(trendline.points)) {
      if (run.length < 2) {
        continue;
      }
      nodes.push({
        kind: "polyline",
        points: run,
        paint: {
          stroke: cssColour(trendline.color),
          strokeWidth: trendline.width ?? 1.5,
          ...(trendline.dash ? { dash: [4, 3] } : {})
        }
      });
    }
    if (trendline.label) {
      nodes.push(textNode(trendline.label));
    }
  }
  for (const marker of series.markers ?? []) {
    nodes.push(...markerNodes(marker));
  }
  // Leader lines before labels so the glyphs sit on top of the stroke rather than
  // being bisected by it.
  for (const leader of series.leaderLines ?? []) {
    nodes.push(lineNode(leader));
  }
  for (const label of series.labels ?? []) {
    nodes.push(textNode(label));
  }
  return nodes;
}

/** The data-table overlay drawn below the plot area. */
function dataTableNodes(table: ChartSceneDataTable): DrawNode[] {
  return [
    // Borders first so cell text paints over them.
    ...table.borders.map(lineNode),
    ...table.legendSwatches.map(swatch => rectNode(swatch, { fill: cssColour(swatch.color) })),
    ...table.cells.map(textNode)
  ];
}

/** Legend swatches and labels. */
function legendNodes(legend: ChartSceneLegend): DrawNode[] {
  if (!legend.visible || legend.items.length === 0) {
    return [];
  }
  const fontSize = legend.textStyle?.fontSize ?? 10;
  const fontFamily = legend.textStyle?.fontFamily ?? "Arial";
  const textColour = cssColour(legend.textStyle?.color ?? "#555");
  const bold = legend.textStyle?.bold;
  const italic = legend.textStyle?.italic;
  const swatchSize = 10;
  const gap = 4;
  const interItem = 16;

  const nodes: DrawNode[] = [];
  // Advance the cursor by the measured label width so a long label cannot overlap
  // the next swatch. Dividing the rect into equal slots — which the SVG emitter
  // used to do — drifted from the PDF emitter for any asymmetric label set.
  let cursorX = legend.rect.x;
  legend.items.forEach((item, index) => {
    const x = legend.orientation === "horizontal" ? cursorX : legend.rect.x;
    const y = legend.orientation === "horizontal" ? legend.rect.y : legend.rect.y + index * 18;
    nodes.push(
      rectNode({ x, y, width: swatchSize, height: swatchSize }, { fill: cssColour(item.color) })
    );
    nodes.push({
      kind: "text",
      x: x + swatchSize + gap,
      y: y + 9,
      lines: [{ text: item.label, dy: 0 }],
      style: {
        size: fontSize,
        fill: textColour,
        anchor: "start",
        family: fontFamily,
        ...(bold ? { bold: true } : {}),
        ...(italic ? { italic: true } : {})
      }
    });
    if (legend.orientation === "horizontal") {
      cursorX +=
        swatchSize +
        gap +
        estimateTextWidth(item.label, fontSize, { bold, italic, fontName: fontFamily }) +
        interItem;
    }
  });
  return nodes;
}

/**
 * Convert a chart scene to a display list.
 *
 * @param scene - The scene produced by `buildChartScene`.
 * @param backgroundColor - Background fill; `"transparent"` omits the rect.
 */
export function sceneToDrawList(scene: ChartScene, backgroundColor = "#fff"): DrawList {
  const children: DrawNode[] = [];

  if (backgroundColor !== "transparent") {
    children.push(
      rectNode(
        { x: 0, y: 0, width: scene.width, height: scene.height },
        { fill: cssColour(backgroundColor) }
      )
    );
  }
  if (scene.title) {
    children.push(textNode(scene.title));
  }
  for (const gridline of scene.gridlines) {
    children.push(lineNode(gridline));
  }
  for (const axis of [scene.axes.x, scene.axes.y, scene.axes.x2, scene.axes.y2]) {
    if (axis) {
      children.push(lineNode(axis));
    }
  }
  for (const labels of [
    scene.xLabels,
    scene.yLabels,
    scene.secondaryXLabels,
    scene.secondaryYLabels,
    scene.axisTitles
  ]) {
    for (const label of labels) {
      children.push(textNode(label));
    }
  }

  // Two passes: every series' shapes, then every series' adornments. A single
  // pass let a later series' filled area cover an earlier series' data labels,
  // which is especially visible on translucent area and radar fills.
  for (const series of scene.series) {
    const shapes = seriesShapes(series);
    const filterId = (series as ChartSceneAdornment).effectFilterId;
    if (filterId) {
      // Adornments stay outside the filter group, matching Excel's convention of
      // drawing sharp markers over a blurred series.
      children.push({ kind: "group", svgFilterId: filterId, children: shapes });
    } else {
      children.push(...shapes);
    }
  }
  for (const series of scene.series) {
    children.push(...adornmentNodes(series));
  }
  if (scene.dataTable) {
    children.push(...dataTableNodes(scene.dataTable));
  }
  children.push(...legendNodes(scene.legend));

  return {
    width: scene.width,
    height: scene.height,
    children,
    ...(scene.effectFilters.length > 0
      ? { svgDefs: scene.effectFilters.map(filter => filter.xml) }
      : {})
  };
}

/**
 * A cubic path through every point, as `c:smooth` asks for.
 *
 * Catmull-Rom converted to Bézier: the curve passes through each data point, which an
 * approximating spline would not, and a chart's line has to touch its own values.
 *
 * The tangents are clamped so the curve cannot leave the range of the data around it. An
 * unclamped Catmull-Rom overshoots at a local extreme — a peak between two lower
 * neighbours bulges past the peak — and on a chart that means ink above the top gridline,
 * in the axis labels: a value of 90 on a 0..100 axis drew 11 px outside the plot. Limiting
 * each tangent to three times the smaller adjacent slope is the standard monotone
 * condition (Fritsch–Carlson); it leaves an ordinary run of points untouched and only
 * bites where the curve would otherwise turn back on itself.
 */
function catmullRomPath(points: readonly DrawPoint[]): DrawPathCommand[] {
  const commands: DrawPathCommand[] = [{ op: "move", x: points[0].x, y: points[0].y }];
  /** Vertical tangent at `i`, clamped against the slopes on either side of it. */
  const tangentY = (i: number): number => {
    const previous = points[i - 1] ?? points[i];
    const next = points[i + 1] ?? points[i];
    const raw = (next.y - previous.y) / 2;
    // A local extreme has slopes of opposite sign; the curve must be flat there, or it
    // overshoots past the point it is supposed to peak at.
    const before = points[i].y - previous.y;
    const after = next.y - points[i].y;
    if (before * after <= 0) {
      return 0;
    }
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
    return Math.sign(raw) * Math.min(Math.abs(raw), limit);
  };
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const runX = (end.x - start.x) / 3;
    commands.push({
      op: "cubic",
      x1: start.x + runX,
      y1: start.y + tangentY(i) / 3,
      x2: end.x - runX,
      y2: end.y - tangentY(i + 1) / 3,
      x: end.x,
      y: end.y
    });
  }
  return commands;
}
