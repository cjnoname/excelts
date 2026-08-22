/**
 * Flowchart → {@link DrawList}.
 *
 * Every outline is expressed with the primitives the engine already has: a rectangle, an
 * ellipse, a closed polyline, or a path when the outline needs a curve. Nothing new was
 * added to the IR for this diagram type, which is the claim the engine was built to
 * support — a producer written against it inherits SVG, pixels and PDF without teaching
 * any of them what a flowchart is.
 *
 * Arrowheads are the case worth naming. A marker is an SVG concept with no counterpart in
 * a content stream or a scanline rasteriser, so the producer lowers it: an arrowhead is a
 * small filled triangle aimed along the last segment, which every backend draws already.
 */

import { cssColour } from "@draw/colour";
import type { DrawNode, DrawPaint, DrawPathCommand, DrawPoint } from "@draw/types";
import type { EdgeRoute, FlowLayout, GroupBox, NodeBox } from "@mermaid/layout/flowchart";
import { ARROW_LENGTH, arrowHead, centredText, layoutTitleBlock } from "@mermaid/render/shared";
import type { Theme } from "@mermaid/theme";
import type { ClassDef, EdgeEnd, EdgeStroke } from "@mermaid/types";

/** Corner radius for the shapes that have one. */
const ROUND_RADIUS = 6;

/** Draw a laid-out flowchart. */
export function flowchartNodes(
  layout: FlowLayout,
  theme: Theme,
  classDefs: readonly ClassDef[],
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const nodes: DrawNode[] = [];
  const classes = new Map(classDefs.map(def => [def.name, def]));

  // Groups first: they are a backdrop, and anything inside must sit on top of them.
  for (const group of layout.groups) {
    nodes.push(...groupNodes(group, theme, fontSize, fontFamily));
  }
  // Edges before nodes, so a line that reaches under a border is covered by it.
  for (const route of layout.edges) {
    nodes.push(...edgeNodes(route, theme));
  }
  for (const box of layout.nodes) {
    nodes.push(...boxNodes(box, theme, classes, fontSize, fontFamily));
  }
  // Labels last of all. Drawn with their edge they sat under whatever box the line passed
  // behind, which is exactly where a long edge's label tends to fall.
  for (const route of layout.edges) {
    nodes.push(...edgeLabelNodes(route, theme, fontSize, fontFamily));
  }
  nodes.push(...layoutTitleBlock(layout.title, fontSize, fontFamily, theme));
  return nodes;
}

/** One node: its outline, then its label. */
function boxNodes(
  box: NodeBox,
  theme: Theme,
  classes: Map<string, ClassDef>,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const def = box.classes.map(name => classes.get(name)).find(entry => entry !== undefined);
  const paint: DrawPaint = {
    fill: def?.fill ? cssColour(def.fill) : theme.nodeFill,
    stroke: def?.stroke ? cssColour(def.stroke) : theme.nodeStroke,
    strokeWidth: def?.strokeWidth ?? 1.5,
    ...(def?.strokeDasharray ? { dash: [...def.strokeDasharray] } : {})
  };

  const out: DrawNode[] = [...outline(box, paint)];
  const textFill = def?.color ? cssColour(def.color) : theme.nodeText;
  out.push(centredText(box, box.lines, fontSize, fontFamily, textFill));
  return out;
}

/**
 * A node's outline.
 *
 * Each shape is written in terms of the box the layout reserved for it, so a shape that
 * needs slack — a rhombus, a hexagon — already has it: the measuring pass added the
 * allowance, and this pass spends it.
 */
function outline(box: NodeBox, paint: DrawPaint): DrawNode[] {
  const { x, y, width: w, height: h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const poly = (points: DrawPoint[]): DrawNode => ({
    kind: "polyline",
    points,
    closed: true,
    paint
  });

  switch (box.shape) {
    case "round":
      return [{ kind: "rect", x, y, width: w, height: h, rx: ROUND_RADIUS, paint }];
    case "stadium":
      return [{ kind: "rect", x, y, width: w, height: h, rx: h / 2, paint }];
    case "stateStart":
      // Solid: the entry point is a mark, not a container.
      return [
        {
          kind: "ellipse",
          cx,
          cy,
          rx: w / 2,
          ry: h / 2,
          paint: { fill: paint.stroke ?? paint.fill, strokeWidth: 0 }
        }
      ];
    case "stateEnd":
      // A disc inside a ring, which is how a final state is drawn everywhere.
      return [
        { kind: "ellipse", cx, cy, rx: w / 2, ry: h / 2, paint: { ...paint, fill: undefined } },
        {
          kind: "ellipse",
          cx,
          cy,
          rx: w / 2 - 4,
          ry: h / 2 - 4,
          paint: { fill: paint.stroke ?? paint.fill, strokeWidth: 0 }
        }
      ];
    case "circle":
      return [{ kind: "ellipse", cx, cy, rx: w / 2, ry: h / 2, paint }];
    case "doubleCircle":
      return [
        { kind: "ellipse", cx, cy, rx: w / 2, ry: h / 2, paint },
        {
          kind: "ellipse",
          cx,
          cy,
          rx: w / 2 - 4,
          ry: h / 2 - 4,
          paint: { ...paint, fill: undefined }
        }
      ];
    case "subroutine":
      return [
        { kind: "rect", x, y, width: w, height: h, paint },
        {
          kind: "polyline",
          points: [
            { x: x + 8, y },
            { x: x + 8, y: y + h }
          ],
          paint: strokeOnly(paint)
        },
        {
          kind: "polyline",
          points: [
            { x: x + w - 8, y },
            { x: x + w - 8, y: y + h }
          ],
          paint: strokeOnly(paint)
        }
      ];
    case "cylinder":
      return cylinder(x, y, w, h, paint);
    case "rhombus":
      return [
        poly([
          { x: cx, y },
          { x: x + w, y: cy },
          { x: cx, y: y + h },
          { x, y: cy }
        ])
      ];
    case "hexagon": {
      const cut = Math.min(18, w / 4);
      return [
        poly([
          { x: x + cut, y },
          { x: x + w - cut, y },
          { x: x + w, y: cy },
          { x: x + w - cut, y: y + h },
          { x: x + cut, y: y + h },
          { x, y: cy }
        ])
      ];
    }
    case "parallelogram": {
      const skew = Math.min(16, w / 5);
      return [
        poly([
          { x: x + skew, y },
          { x: x + w, y },
          { x: x + w - skew, y: y + h },
          { x, y: y + h }
        ])
      ];
    }
    case "parallelogramAlt": {
      const skew = Math.min(16, w / 5);
      return [
        poly([
          { x, y },
          { x: x + w - skew, y },
          { x: x + w, y: y + h },
          { x: x + skew, y: y + h }
        ])
      ];
    }
    case "trapezoid": {
      const cut = Math.min(20, w / 4);
      return [
        poly([
          { x: x + cut, y },
          { x: x + w - cut, y },
          { x: x + w, y: y + h },
          { x, y: y + h }
        ])
      ];
    }
    case "trapezoidAlt": {
      const cut = Math.min(20, w / 4);
      return [
        poly([
          { x, y },
          { x: x + w, y },
          { x: x + w - cut, y: y + h },
          { x: x + cut, y: y + h }
        ])
      ];
    }
    case "asymmetric": {
      const point = Math.min(14, w / 5);
      return [
        poly([
          { x, y },
          { x: x + w - point, y },
          { x: x + w, y: cy },
          { x: x + w - point, y: y + h },
          { x, y: y + h }
        ])
      ];
    }
    case "rect":
    default:
      return [{ kind: "rect", x, y, width: w, height: h, paint }];
  }
}

/**
 * A database cylinder: a body with an elliptical lid.
 *
 * The lid is drawn twice — once as the top of the filled body, once as a stroked arc — so
 * the curve reads as a rim rather than as a seam across a flat rectangle.
 */
function cylinder(x: number, y: number, w: number, h: number, paint: DrawPaint): DrawNode[] {
  const ry = Math.min(9, h / 4);
  const body: DrawPathCommand[] = [
    { op: "move", x, y: y + ry },
    { op: "cubic", x1: x, y1: y, x2: x + w, y2: y, x: x + w, y: y + ry },
    { op: "line", x: x + w, y: y + h - ry },
    { op: "cubic", x1: x + w, y1: y + h, x2: x, y2: y + h, x, y: y + h - ry },
    { op: "close" }
  ];
  const rim: DrawPathCommand[] = [
    { op: "move", x, y: y + ry },
    { op: "cubic", x1: x, y1: y + ry * 2, x2: x + w, y2: y + ry * 2, x: x + w, y: y + ry }
  ];
  return [
    { kind: "path", commands: body, paint },
    { kind: "path", commands: rim, paint: strokeOnly(paint) }
  ];
}

function strokeOnly(paint: DrawPaint): DrawPaint {
  const { fill: _fill, ...rest } = paint;
  return rest;
}

/** One edge: its line, its end decorations, and its label. */
export function edgeNodes(route: EdgeRoute, theme: Theme): DrawNode[] {
  const out: DrawNode[] = [];
  const paint: DrawPaint = {
    stroke: theme.edge,
    strokeWidth: route.edge.stroke === "thick" ? 3 : 1.6,
    lineJoin: "round",
    lineCap: "round",
    ...dashFor(route.edge.stroke)
  };

  // Shorten the line where a solid head will cover it, so the stroke does not poke out of
  // the arrow's tip when the line is thick.
  const points = trimForHeads(route.points, route.edge.startEnd, route.edge.endEnd);
  out.push({ kind: "polyline", points, paint });

  const headPaint: DrawPaint = { fill: theme.edge, stroke: theme.edge, strokeWidth: 1 };
  if (route.edge.endEnd !== "none") {
    out.push(...endDecoration(route.points, false, route.edge.endEnd, headPaint, theme));
  }
  if (route.edge.startEnd !== "none") {
    out.push(...endDecoration(route.points, true, route.edge.startEnd, headPaint, theme));
  }

  return out;
}

/** An edge's label, with a panel so the line does not run through the words. */
export function edgeLabelNodes(
  route: EdgeRoute,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  if (!route.label) {
    return [];
  }
  return [
    {
      kind: "rect",
      x: route.label.x - 4,
      y: route.label.y - 2,
      width: route.label.width + 8,
      height: route.label.height + 4,
      rx: 3,
      paint: { fill: theme.edgeLabelBackground }
    },
    centredText(
      { x: route.label.x, y: route.label.y, width: route.label.width, height: route.label.height },
      route.label.lines,
      fontSize - 2,
      fontFamily,
      theme.edgeText
    )
  ];
}

function dashFor(stroke: EdgeStroke): { dash?: number[] } {
  return stroke === "dotted" ? { dash: [5, 5] } : {};
}

/**
 * Pull the line back from any end that carries a filled head.
 *
 * The head is opaque, so a line running to the same point would be hidden — except at a
 * thick stroke, where the shaft is wider than the head's base and shows around it.
 */
function trimForHeads(
  points: readonly DrawPoint[],
  startEnd: EdgeEnd,
  endEnd: EdgeEnd
): DrawPoint[] {
  const out = points.map(point => ({ ...point }));
  if (out.length < 2) {
    return out;
  }
  if (endEnd === "arrow") {
    shorten(out[out.length - 1], out[out.length - 2], ARROW_LENGTH * 0.85);
  }
  if (startEnd === "arrow") {
    shorten(out[0], out[1], ARROW_LENGTH * 0.85);
  }
  return out;
}

/** Move `end` towards `towards` by `distance`. */
function shorten(end: { x: number; y: number }, towards: DrawPoint, distance: number): void {
  const dx = towards.x - end.x;
  const dy = towards.y - end.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return;
  }
  end.x += (dx / length) * Math.min(distance, length);
  end.y += (dy / length) * Math.min(distance, length);
}

/**
 * The decoration at one end of an edge.
 *
 * Aimed along the final segment, which is why the *untrimmed* points are used: trimming
 * moved the tip, and the head belongs where the line originally ended.
 */
function endDecoration(
  points: readonly DrawPoint[],
  atStart: boolean,
  end: EdgeEnd,
  paint: DrawPaint,
  theme: Theme
): DrawNode[] {
  const tip = atStart ? points[0] : points[points.length - 1];
  const previous = atStart ? points[1] : points[points.length - 2];
  if (!tip || !previous) {
    return [];
  }
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [];
  }
  const ux = dx / length;
  const uy = dy / length;

  if (end === "arrow") {
    return arrowHead(tip, previous, paint);
  }
  if (end === "circle") {
    const r = 4.5;
    return [
      {
        kind: "ellipse",
        cx: tip.x - ux * r,
        cy: tip.y - uy * r,
        rx: r,
        ry: r,
        paint: { fill: theme.edgeLabelBackground, stroke: theme.edge, strokeWidth: 1.6 }
      }
    ];
  }
  // A cross: two strokes through the tip, at the size of an arrowhead.
  const arm = 5;
  const px = -uy;
  const py = ux;
  const line = (ax: number, ay: number, bx: number, by: number): DrawNode => ({
    kind: "polyline",
    points: [
      { x: ax, y: ay },
      { x: bx, y: by }
    ],
    paint: { stroke: theme.edge, strokeWidth: 1.8, lineCap: "round" }
  });
  const centreX = tip.x - ux * arm;
  const centreY = tip.y - uy * arm;
  return [
    line(
      centreX - ux * arm - px * arm,
      centreY - uy * arm - py * arm,
      centreX + ux * arm + px * arm,
      centreY + uy * arm + py * arm
    ),
    line(
      centreX - ux * arm + px * arm,
      centreY - uy * arm + py * arm,
      centreX + ux * arm - px * arm,
      centreY + uy * arm - py * arm
    )
  ];
}

/** A subgraph frame with its name in the top-left. */
export function groupNodes(
  group: GroupBox,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const out: DrawNode[] = [
    {
      kind: "rect",
      x: group.x,
      y: group.y,
      width: group.width,
      height: group.height,
      rx: 6,
      paint: { fill: theme.groupFill, stroke: theme.groupStroke, strokeWidth: 1.2 }
    }
  ];
  if (group.text !== "") {
    out.push({
      kind: "text",
      x: group.x + 10,
      y: group.y + fontSize + 4,
      lines: [{ text: group.text, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "start",
        bold: true,
        fill: theme.nodeText
      }
    });
  }
  return out;
}
