/**
 * `quadrantChart`, `xychart` and `sankey`.
 *
 * Three plots rather than three graphs: a point's position is its data, so there is
 * nothing to lay out and each is a single pass. What they do share is the axis furniture —
 * a frame, ticks, captions — which is why they sit together.
 */

import { measureText, widestText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawPathCommand, DrawTextStyle } from "@draw/types";
import { backdrop, formatTick, titleBlock, titleNode } from "@mermaid/render/shared";
import { BASELINE_SHIFT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { QuadrantDiagram, SankeyDiagram, XyDiagram } from "@mermaid/types";

/** Draw a quadrant chart. */
export function quadrantDrawList(
  diagram: QuadrantDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const size = 380;
  const axisRoom = fontSize * 2.4;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;

  const left = padding + axisRoom;
  const top = padding + titleHeight;
  const width = left + size + padding;
  const height = top + size + axisRoom + padding;

  // Both axes run 0..1 with y increasing upward, which is how the source writes them.
  const px = (x: number): number => left + Math.min(1, Math.max(0, x)) * size;
  const py = (y: number): number => top + size - Math.min(1, Math.max(0, y)) * size;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // The four quadrants, tinted so the names have something to sit on. Mermaid numbers them
  // top-right, top-left, bottom-left, bottom-right, which is anticlockwise from the top
  // right — the same order a mathematician numbers them in.
  const order = [
    { x: 1, y: 0, index: 0 },
    { x: 0, y: 0, index: 1 },
    { x: 0, y: 1, index: 2 },
    { x: 1, y: 1, index: 3 }
  ];
  order.forEach(cell => {
    const colour = theme.palette[cell.index % theme.palette.length];
    children.push({
      kind: "rect",
      x: left + cell.x * (size / 2),
      y: top + cell.y * (size / 2),
      width: size / 2,
      height: size / 2,
      paint: { fill: { ...colour, a: 0.13 } }
    });
    const name = diagram.quadrants[cell.index];
    if (name !== "") {
      children.push({
        kind: "text",
        x: left + cell.x * (size / 2) + size / 4,
        y: top + cell.y * (size / 2) + fontSize * 1.8,
        lines: [{ text: name, dy: 0 }],
        style: {
          size: fontSize,
          family: fontFamily,
          anchor: "middle",
          bold: true,
          fill: colour
        }
      });
    }
  });

  // The dividing lines and the frame.
  const frame: DrawPaint = { stroke: theme.nodeStroke, strokeWidth: 1.4 };
  children.push({ kind: "rect", x: left, y: top, width: size, height: size, paint: frame });
  children.push({
    kind: "polyline",
    points: [
      { x: left + size / 2, y: top },
      { x: left + size / 2, y: top + size }
    ],
    paint: frame
  });
  children.push({
    kind: "polyline",
    points: [
      { x: left, y: top + size / 2 },
      { x: left + size, y: top + size / 2 }
    ],
    paint: frame
  });

  // Axis captions, low end at the origin.
  if (diagram.xAxis) {
    children.push(
      caption(
        diagram.xAxis[0],
        left + size / 4,
        top + size + fontSize * 1.5,
        fontSize,
        fontFamily,
        theme
      )
    );
    if (diagram.xAxis[1] !== "") {
      children.push(
        caption(
          diagram.xAxis[1],
          left + (size * 3) / 4,
          top + size + fontSize * 1.5,
          fontSize,
          fontFamily,
          theme
        )
      );
    }
  }
  if (diagram.yAxis) {
    children.push({
      kind: "text",
      x: left - 10,
      y: top + (size * 3) / 4,
      lines: [{ text: diagram.yAxis[0], dy: 0 }],
      style: { size: fontSize - 1, family: fontFamily, anchor: "middle", fill: theme.edgeText },
      rotate: -90
    });
    if (diagram.yAxis[1] !== "") {
      children.push({
        kind: "text",
        x: left - 10,
        y: top + size / 4,
        lines: [{ text: diagram.yAxis[1], dy: 0 }],
        style: { size: fontSize - 1, family: fontFamily, anchor: "middle", fill: theme.edgeText },
        rotate: -90
      });
    }
  }

  for (const point of diagram.points) {
    const cx = px(point.x);
    const cy = py(point.y);
    children.push({
      kind: "ellipse",
      cx,
      cy,
      rx: 6,
      ry: 6,
      paint: { fill: theme.nodeStroke, stroke: theme.edgeLabelBackground, strokeWidth: 1.5 }
    });
    // Placed to the side that keeps it inside the frame.
    const toLeft = cx > left + size * 0.7;
    children.push({
      kind: "text",
      x: cx + (toLeft ? -10 : 10),
      y: cy + (fontSize - 2) * BASELINE_SHIFT,
      lines: [{ text: point.label, dy: 0 }],
      style: {
        size: fontSize - 2,
        family: fontFamily,
        anchor: toLeft ? "end" : "start",
        fill: theme.nodeText
      }
    });
  }

  return { width, height, children };
}

/** Draw an XY chart. */
export function xyDrawList(
  diagram: XyDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const tickStyle: DrawTextStyle = { size: fontSize - 2, family: fontFamily };
  const counts = diagram.series.map(series => series.values.length);
  const points = Math.max(diagram.categories.length, ...counts);
  if (points === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const values = diagram.series.flatMap(series => series.values);
  const low = diagram.yRange ? diagram.yRange[0] : Math.min(0, ...values);
  const high = diagram.yRange ? diagram.yRange[1] : Math.max(...values, low + 1);
  const span = high - low || 1;

  const tickWidth =
    Math.max(measureText(formatTick(low), tickStyle), measureText(formatTick(high), tickStyle)) +
    12;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const categoryRoom = fontSize * 2;
  const axisTitleRoom = diagram.xTitle ? fontSize * 1.8 : 0;
  const yTitleRoom = diagram.yTitle ? fontSize * 1.8 : 0;

  const plotWidth = Math.max(320, points * 62);
  const plotHeight = 240;
  const left = padding + yTitleRoom + tickWidth;
  const top = padding + titleHeight;
  const width = left + plotWidth + padding;
  const height = top + plotHeight + categoryRoom + axisTitleRoom + padding;

  const px = (index: number): number => left + ((index + 0.5) / points) * plotWidth;
  const py = (value: number): number => top + plotHeight - ((value - low) / span) * plotHeight;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));

  // Horizontal rules, five of them, with their values.
  for (let step = 0; step <= 4; step++) {
    const value = low + (span * step) / 4;
    const y = py(value);
    children.push({
      kind: "polyline",
      points: [
        { x: left, y },
        { x: left + plotWidth, y }
      ],
      paint: { stroke: theme.groupStroke, strokeWidth: 0.7, dash: [3, 3] }
    });
    children.push({
      kind: "text",
      x: left - 8,
      y: y + (fontSize - 2) * BASELINE_SHIFT,
      lines: [{ text: formatTick(value), dy: 0 }],
      style: { size: fontSize - 2, family: fontFamily, anchor: "end", fill: theme.edgeText }
    });
  }

  const bars = diagram.series.filter(series => series.type === "bar");
  const slot = plotWidth / points;
  // Bars grow from zero, not from the bottom of the range. Anchoring at `low` drew a value
  // of -5 as a tall bar rising from -10, so a negative reading looked like a large positive
  // one. Only when the whole range sits on one side of zero does the nearer bound stand in
  // for it, which is the case for the ordinary chart that starts at zero anyway.
  const baseline = Math.min(Math.max(0, low), high);
  bars.forEach((series, seriesIndex) => {
    const barWidth = (slot * 0.62) / bars.length;
    series.values.forEach((value, index) => {
      const centre = px(index);
      const x = centre - (barWidth * bars.length) / 2 + seriesIndex * barWidth;
      const from = py(baseline);
      const to = py(Math.max(low, Math.min(high, value)));
      children.push({
        kind: "rect",
        x,
        y: Math.min(from, to),
        width: barWidth,
        // A bar of no height still marks the category it belongs to.
        height: Math.max(1, Math.abs(from - to)),
        rx: 2,
        paint: { fill: theme.palette[seriesIndex % theme.palette.length] }
      });
    });
  });

  let lineIndex = bars.length;
  for (const series of diagram.series) {
    if (series.type !== "line") {
      continue;
    }
    const colour = theme.palette[lineIndex % theme.palette.length];
    children.push({
      kind: "polyline",
      points: series.values.map((value, index) => ({ x: px(index), y: py(value) })),
      paint: { stroke: colour, strokeWidth: 2.4, lineJoin: "round", lineCap: "round" }
    });
    for (const [index, value] of series.values.entries()) {
      children.push({
        kind: "ellipse",
        cx: px(index),
        cy: py(value),
        rx: 3.5,
        ry: 3.5,
        paint: { fill: colour }
      });
    }
    lineIndex++;
  }

  // Category labels.
  diagram.categories.forEach((category, index) => {
    if (index >= points) {
      return;
    }
    children.push({
      kind: "text",
      x: px(index),
      y: top + plotHeight + fontSize * 1.4,
      lines: [{ text: category, dy: 0 }],
      style: { size: fontSize - 2, family: fontFamily, anchor: "middle", fill: theme.edgeText }
    });
  });

  if (diagram.xTitle) {
    children.push(
      caption(diagram.xTitle, left + plotWidth / 2, height - padding, fontSize, fontFamily, theme)
    );
  }
  if (diagram.yTitle) {
    children.push({
      kind: "text",
      x: padding + fontSize * 0.6,
      y: top + plotHeight / 2,
      lines: [{ text: diagram.yTitle, dy: 0 }],
      style: { size: fontSize - 1, family: fontFamily, anchor: "middle", fill: theme.edgeText },
      rotate: -90
    });
  }

  // The title belongs to the diagram, not to the plot, so it is added after any
  // transposition — reflected with everything else it ended up down the right-hand side.
  const withTitle = (list: DrawNode[], w: number): DrawNode[] =>
    diagram.title === undefined
      ? list
      : [...list, titleNode(diagram.title, w / 2, padding + fontSize, fontSize, fontFamily, theme)];

  if (!diagram.horizontal) {
    return { width, height, children: withTitle(children, width) };
  }
  // `horizontal` swaps which axis carries the values, and reflecting the finished chart
  // across its own diagonal does that in one place — a bar that grew upwards grows
  // rightwards, the categories run down the side. Rebuilding every coordinate for the second
  // orientation would be a second chart renderer, and the two would drift.
  //
  // The diagonal alone is not enough, though. A vertical chart's value axis grows *up*, and
  // reflecting "up" gives "left": the scale came out mirrored, counting down from the right.
  // Flipping x afterwards puts the origin back at the left, where a horizontal chart's is.
  // Transposing puts the value-axis caption where the title goes, so it is moved to the far
  // side afterwards: on a horizontal chart the value axis is the bottom one, and its name
  // belongs beneath it.
  const flipped = height;
  const titleBand = padding + titleHeight;
  const moved = children.map(node => {
    const turned = transpose(node, flipped);
    if (turned.kind !== "text" || turned.y > titleBand) {
      return turned;
    }
    return { ...turned, y: width - padding * 0.4 };
  });
  return {
    width: height,
    height: width,
    children: withTitle(moved, height)
  };
}

/**
 * Reflect a node across `x = y`, then flip x within `span`.
 *
 * The two together turn "up is more" into "right is more", which is what a horizontal chart
 * means and what a bare transposition does not give.
 */
function transpose(node: DrawNode, span: number): DrawNode {
  const mx = (y: number): number => span - y;
  switch (node.kind) {
    case "rect":
      return {
        ...node,
        x: mx(node.y + node.height),
        y: node.x,
        width: node.height,
        height: node.width
      };
    case "ellipse":
      return { ...node, cx: mx(node.cy), cy: node.cx, rx: node.ry, ry: node.rx };
    case "polyline":
      return { ...node, points: node.points.map(point => ({ x: mx(point.y), y: point.x })) };
    case "line":
      return { ...node, x1: mx(node.y1), y1: node.x1, x2: mx(node.y2), y2: node.x2 };
    case "text":
      // Words are moved and left upright: reflecting them makes them unreadable, which is
      // why every charting library does the same with a transposed axis. An `end` anchor
      // becomes `start` because the side it was hugging is now the other one.
      return {
        ...node,
        x: mx(node.y),
        y: node.x,
        ...(node.rotate === undefined ? {} : { rotate: 0 }),
        style: {
          ...node.style,
          anchor:
            node.style.anchor === "end"
              ? "start"
              : node.style.anchor === "start"
                ? "end"
                : node.style.anchor
        }
      };
    case "path":
      return {
        ...node,
        commands: node.commands.map(command =>
          command.op === "close"
            ? command
            : command.op === "cubic"
              ? {
                  op: "cubic",
                  x1: mx(command.y1),
                  y1: command.x1,
                  x2: mx(command.y2),
                  y2: command.x2,
                  x: mx(command.y),
                  y: command.x
                }
              : { op: command.op, x: mx(command.y), y: command.x }
        )
      };
    default:
      return node;
  }
}

/** Draw a Sankey diagram. */
export function sankeyDrawList(
  diagram: SankeyDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  if (diagram.links.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  // Depth by longest path from a source, which is what puts a node to the right of
  // everything that feeds it.
  const names = new Set<string>();
  for (const link of diagram.links) {
    names.add(link.from);
    names.add(link.to);
  }
  // Longest path, but only over the links that point forwards. A cycle has no depth
  // assignment that satisfies every link, so relaxing all of them pushes the depths up on
  // every pass until they stop — at a number far past the column count the canvas was
  // sized from, which puts the nodes outside it. The back link still gets drawn; it just
  // does not get a vote, exactly as a flowchart's back edge does not.
  const forward = forwardLinks(diagram.links);
  const depth = new Map<string, number>();
  for (const name of names) {
    depth.set(name, 0);
  }
  for (let pass = 0; pass < names.size; pass++) {
    let moved = false;
    for (const link of forward) {
      const want = (depth.get(link.from) ?? 0) + 1;
      if (want > (depth.get(link.to) ?? 0)) {
        depth.set(link.to, want);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  // A node is as tall as the larger of what flows in and what flows out.
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const link of diagram.links) {
    outflow.set(link.from, (outflow.get(link.from) ?? 0) + link.value);
    inflow.set(link.to, (inflow.get(link.to) ?? 0) + link.value);
  }
  const weight = (name: string): number => Math.max(inflow.get(name) ?? 0, outflow.get(name) ?? 0);

  const columns = new Map<number, string[]>();
  for (const name of names) {
    const at = depth.get(name) ?? 0;
    const column = columns.get(at);
    if (column === undefined) {
      columns.set(at, [name]);
    } else {
      column.push(name);
    }
  }
  const depths = [...columns.keys()].sort((a, b) => a - b);

  const nodeWidth = 16;
  const nodeGap = 14;
  const plotHeight = 320;
  const columnGap = 190;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;

  // The tightest column decides the scale, and a column's room is what is left after its
  // own gaps: reserving a fixed four made a column of eight nodes overflow the plot.
  const scale = Math.min(
    ...depths.map(at => {
      const members = columns.get(at) ?? [];
      const total = members.reduce((sum, name) => sum + weight(name), 0);
      const room = plotHeight - Math.max(0, members.length - 1) * nodeGap;
      return total > 0 && room > 0 ? room / total : 1;
    }),
    1
  );

  const box = new Map<string, { x: number; y: number; height: number }>();
  const top = padding + titleHeight;
  depths.forEach(at => {
    const members = (columns.get(at) ?? []).sort((a, b) => weight(b) - weight(a));
    const total =
      members.reduce((sum, name) => sum + weight(name) * scale, 0) + (members.length - 1) * nodeGap;
    let y = top + (plotHeight - total) / 2;
    for (const name of members) {
      const h = Math.max(4, weight(name) * scale);
      box.set(name, { x: padding + at * columnGap, y, height: h });
      y += h + nodeGap;
    }
  });

  const labelRoom = widestText([...names], style) + 14;
  // Sized from the largest depth, not from how many distinct depths there are: a diagram
  // whose depths are 0, 1 and 4 needs five columns of room, not three.
  const width = padding + Math.max(...depths) * columnGap + nodeWidth + labelRoom + padding;
  const height = top + plotHeight + padding;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // Ribbons, stacked against each node in the order they were written.
  const usedOut = new Map<string, number>();
  const usedIn = new Map<string, number>();
  const colourOf = new Map<string, number>();
  [...names].forEach((name, index) => colourOf.set(name, index));

  for (const link of diagram.links) {
    const from = box.get(link.from);
    const to = box.get(link.to);
    if (!from || !to) {
      continue;
    }
    const thickness = Math.max(1, link.value * scale);
    const y1 = from.y + (usedOut.get(link.from) ?? 0);
    const y2 = to.y + (usedIn.get(link.to) ?? 0);
    usedOut.set(link.from, (usedOut.get(link.from) ?? 0) + thickness);
    usedIn.set(link.to, (usedIn.get(link.to) ?? 0) + thickness);

    const x1 = from.x + nodeWidth;
    const x2 = to.x;
    const reach = (x2 - x1) * 0.5;
    // A closed ribbon rather than a thick line: the two ends differ in height whenever a
    // node splits its flow, and a stroke cannot taper.
    const commands: DrawPathCommand[] = [
      { op: "move", x: x1, y: y1 },
      { op: "cubic", x1: x1 + reach, y1, x2: x2 - reach, y2, x: x2, y: y2 },
      { op: "line", x: x2, y: y2 + thickness },
      {
        op: "cubic",
        x1: x2 - reach,
        y1: y2 + thickness,
        x2: x1 + reach,
        y2: y1 + thickness,
        x: x1,
        y: y1 + thickness
      },
      { op: "close" }
    ];
    const colour = theme.palette[(colourOf.get(link.from) ?? 0) % theme.palette.length];
    children.push({ kind: "path", commands, paint: { fill: { ...colour, a: 0.42 } } });
  }

  for (const name of names) {
    const node = box.get(name);
    if (!node) {
      continue;
    }
    const colour = theme.palette[(colourOf.get(name) ?? 0) % theme.palette.length];
    children.push({
      kind: "rect",
      x: node.x,
      y: node.y,
      width: nodeWidth,
      height: node.height,
      rx: 2,
      paint: { fill: colour }
    });
    // Labels go outside on the last column and inside elsewhere, so none runs off the edge.
    const last = (depth.get(name) ?? 0) === depths[depths.length - 1];
    children.push({
      kind: "text",
      x: last ? node.x - 8 : node.x + nodeWidth + 8,
      y: node.y + node.height / 2 + fontSize * BASELINE_SHIFT,
      lines: [{ text: name, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: last ? "end" : "start",
        fill: theme.nodeText
      }
    });
  }

  return { width, height, children };
}

/**
 * The links that point forwards, found by dropping the ones that close a cycle.
 *
 * Depth-first: a link back into the path currently being walked is what makes a cycle, and
 * leaving it out is the only way to give every other link a consistent depth.
 */
function forwardLinks(links: readonly SankeyDiagram["links"][number][]): SankeyDiagram["links"] {
  const outgoing = new Map<string, string[]>();
  for (const link of links) {
    const from = outgoing.get(link.from);
    if (from === undefined) {
      outgoing.set(link.from, [link.to]);
    } else {
      from.push(link.to);
    }
  }
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const walk = (id: string): void => {
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        back.add(`${id}\u0000${next}`);
        continue;
      }
      if (seen === 0) {
        walk(next);
      }
    }
    state.set(id, 2);
  };
  for (const link of links) {
    if ((state.get(link.from) ?? 0) === 0) {
      walk(link.from);
    }
  }
  return links.filter(link => !back.has(`${link.from}\u0000${link.to}`) && link.from !== link.to);
}

function caption(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  theme: Theme
): DrawNode {
  return {
    kind: "text",
    x,
    y,
    lines: [{ text, dy: 0 }],
    style: { size: fontSize - 1, family: fontFamily, anchor: "middle", fill: theme.edgeText }
  };
}
