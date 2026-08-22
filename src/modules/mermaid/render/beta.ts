/**
 * `packet`, `kanban`, `radar` and `architecture`.
 *
 * Four layouts with nothing in common: a packet is a bit grid, a kanban board is columns of
 * cards, a radar is polar, an architecture diagram is a graph of services. They share a
 * file because each is short, and a module per hundred lines would say more about how they
 * were written than about what they are.
 */

import { widestText, wrapText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawPoint, DrawTextStyle } from "@draw/types";
import type { FlowLayout } from "@mermaid/layout/flowchart";
import { edgeNodes } from "@mermaid/render/flowchart";
import { backdrop, layoutTitleBlock, legendEntry, titleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT, LINE_HEIGHT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type {
  ArchitectureDiagram,
  ArchitectureNode,
  FlowchartDiagram,
  KanbanDiagram,
  PacketDiagram,
  RadarDiagram
} from "@mermaid/types";

/** Draw a packet diagram: one row per `bitsPerRow`, cells sized by their bit span. */
export function packetDrawList(
  diagram: PacketDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  if (diagram.fields.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }
  const bits = diagram.bitsPerRow;
  const bitWidth = 26;
  const cellStyle: DrawTextStyle = { size: fontSize - 2, family: fontFamily };
  // A one-bit field is 26 units wide and its name may be a sentence, so the row has to be
  // tall enough for the wrapped label — unwrapped it ran straight over its neighbours and
  // over the bit numbers.
  const wrapped = new Map<number, string[]>();
  diagram.fields.forEach((field, index) => {
    const span = field.end - field.start + 1;
    wrapped.set(index, wrapText(field.label, cellStyle, Math.max(20, span * bitWidth - 8)));
  });
  const tallest = Math.max(1, ...[...wrapped.values()].map(lines => lines.length));
  const rowHeight = fontSize * 2.2 + tallest * (fontSize - 2) * LINE_HEIGHT;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;

  const lastBit = Math.max(...diagram.fields.map(field => field.end));
  const rows = Math.floor(lastBit / bits) + 1;
  const width = padding * 2 + bits * bitWidth;
  const height = padding * 2 + titleHeight + rows * rowHeight;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  const top = padding + titleHeight;
  diagram.fields.forEach((field, index) => {
    // A field may straddle a row boundary; each row it touches is drawn as its own cell.
    for (let bit = field.start; bit <= field.end;) {
      const row = Math.floor(bit / bits);
      const rowEnd = Math.min(field.end, (row + 1) * bits - 1);
      const from = bit % bits;
      const span = rowEnd - bit + 1;
      const x = padding + from * bitWidth;
      const y = top + row * rowHeight;
      children.push({
        kind: "rect",
        x,
        y,
        width: span * bitWidth,
        height: rowHeight - 8,
        paint: {
          fill: { ...theme.palette[index % theme.palette.length], a: 0.55 },
          stroke: theme.nodeStroke,
          strokeWidth: 1.2
        }
      });
      const centre = x + (span * bitWidth) / 2;
      const lines = wrapped.get(index) ?? [field.label];
      const step = (fontSize - 2) * LINE_HEIGHT;
      children.push({
        kind: "text",
        x: centre,
        y:
          y +
          (rowHeight - 8) / 2 -
          ((lines.length - 1) * step) / 2 +
          (fontSize - 2) * BASELINE_SHIFT,
        lines: lines.map((text, line) => ({ text, dy: line * step })),
        style: { size: fontSize - 2, family: fontFamily, anchor: "middle", fill: theme.nodeText }
      });
      // Bit numbers at the two ends, which is what the diagram is read for.
      children.push(
        bitLabel(String(bit), x + 3, y + fontSize - 2, fontSize, fontFamily, theme, "start")
      );
      if (rowEnd !== bit) {
        children.push(
          bitLabel(
            String(rowEnd),
            x + span * bitWidth - 3,
            y + fontSize - 2,
            fontSize,
            fontFamily,
            theme,
            "end"
          )
        );
      }
      bit = rowEnd + 1;
    }
  });

  return { width, height, children };
}

function bitLabel(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  theme: Theme,
  anchor: "start" | "end"
): DrawNode {
  return {
    kind: "text",
    x,
    y,
    lines: [{ text, dy: 0 }],
    style: { size: fontSize - 4, family: fontFamily, anchor, fill: theme.edgeText }
  };
}

/** Draw a kanban board: a titled column per list, a panel per card. */
export function kanbanDrawList(
  diagram: KanbanDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  if (diagram.columns.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }
  const cardStyle: DrawTextStyle = { size: fontSize - 1, family: fontFamily };
  const columnWidth = 190;
  const columnGap = 16;
  const cardGap = 8;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const headerHeight = fontSize * 2.4;

  const wrapped = diagram.columns.map(column =>
    column.cards.map(card => ({
      card,
      lines: wrapText(card.text, cardStyle, columnWidth - 28),
      // Wrapped, because an assignee and a priority joined together easily exceed the
      // column and ran over the one beside it.
      meta: wrapText(
        [card.assigned, card.priority, card.ticket]
          .filter((entry): entry is string => entry !== undefined)
          .join(" · "),
        { size: fontSize - 3, family: fontFamily },
        columnWidth - 32
      ).filter(line => line !== "")
    }))
  );
  const columnHeights = wrapped.map(cards =>
    cards.reduce(
      (sum, entry) =>
        sum +
        entry.lines.length * (fontSize - 1) * LINE_HEIGHT +
        entry.meta.length * (fontSize - 3) * LINE_HEIGHT +
        18 +
        cardGap,
      0
    )
  );

  const top = padding + titleHeight;
  const width =
    padding * 2 + diagram.columns.length * columnWidth + (diagram.columns.length - 1) * columnGap;
  const height = top + headerHeight + Math.max(60, Math.max(...columnHeights)) + padding + 8;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  diagram.columns.forEach((column, index) => {
    const x = padding + index * (columnWidth + columnGap);
    const colour = theme.palette[index % theme.palette.length];
    // The lane, so a column reads as a container rather than as a floating stack.
    children.push({
      kind: "rect",
      x,
      y: top,
      width: columnWidth,
      height: height - top - padding,
      rx: 6,
      paint: { fill: theme.groupFill }
    });
    children.push({
      kind: "rect",
      x,
      y: top,
      width: columnWidth,
      height: headerHeight,
      rx: 6,
      paint: { fill: colour }
    });
    children.push({
      kind: "text",
      x: x + columnWidth / 2,
      y: top + headerHeight / 2 + fontSize * BASELINE_SHIFT,
      lines: [{ text: column.title, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "middle",
        bold: true,
        fill: theme.paletteText(colour)
      }
    });

    let y = top + headerHeight + cardGap;
    for (const entry of wrapped[index]) {
      const textHeight = entry.lines.length * (fontSize - 1) * LINE_HEIGHT;
      const metaHeight = entry.meta.length * (fontSize - 3) * LINE_HEIGHT;
      const cardHeight = textHeight + metaHeight + 18;
      children.push({
        kind: "rect",
        x: x + 8,
        y,
        width: columnWidth - 16,
        height: cardHeight,
        rx: 4,
        paint: { fill: theme.edgeLabelBackground, stroke: theme.nodeStroke, strokeWidth: 1 }
      });
      const step = (fontSize - 1) * LINE_HEIGHT;
      children.push({
        kind: "text",
        x: x + 16,
        y: y + 9 + step - step * 0.28,
        lines: entry.lines.map((text, line) => ({ text, dy: line * step })),
        style: { size: fontSize - 1, family: fontFamily, anchor: "start", fill: theme.nodeText }
      });
      if (entry.meta.length > 0) {
        const metaStep = (fontSize - 3) * LINE_HEIGHT;
        children.push({
          kind: "text",
          x: x + 16,
          y: y + 9 + textHeight + metaStep * 0.72,
          lines: entry.meta.map((text, line) => ({ text, dy: line * metaStep })),
          style: {
            size: fontSize - 3,
            family: fontFamily,
            anchor: "start",
            italic: true,
            fill: theme.edgeText
          }
        });
      }
      y += cardHeight + cardGap;
    }
  });

  return { width, height, children };
}

/** Draw a radar chart: one spoke per axis, one closed ring per series. */
export function radarDrawList(
  diagram: RadarDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const axes = diagram.axes;
  if (axes.length < 3 || diagram.series.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }
  const style: DrawTextStyle = { size: fontSize - 1, family: fontFamily };

  const radius = 140;
  const labelRoom = widestText(axes, style) + 18;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const legendHeight = diagram.series.length * fontSize * 1.7 + 8;

  const size = (radius + labelRoom) * 2;
  const width = padding * 2 + size;
  const height = padding * 2 + titleHeight + size + legendHeight;
  const cx = width / 2;
  const cy = padding + titleHeight + size / 2;

  // An explicit `max` sets the scale. Letting the data raise it meant a value past the stated
  // maximum silently rescaled the whole chart, so every other reading shrank and the axis no
  // longer meant what the source said. A value past the top is clamped to it instead, which
  // shows as "at the limit" rather than hiding as a new limit.
  const highest =
    diagram.max !== undefined && diagram.max > 0
      ? diagram.max
      : Math.max(...diagram.series.flatMap(series => series.values), 1);
  // Start at twelve o'clock and run clockwise, which is how a radar is read.
  const angleOf = (index: number): number => -Math.PI / 2 + (index / axes.length) * Math.PI * 2;
  const at = (index: number, value: number): DrawPoint => {
    const r = (Math.min(highest, Math.max(0, value)) / highest) * radius;
    return { x: cx + Math.cos(angleOf(index)) * r, y: cy + Math.sin(angleOf(index)) * r };
  };

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // Rings and spokes.
  for (let ring = 1; ring <= 4; ring++) {
    children.push({
      kind: "polyline",
      closed: true,
      points: axes.map((_, index) => at(index, (highest * ring) / 4)),
      paint: { stroke: theme.groupStroke, strokeWidth: 0.8, dash: ring === 4 ? undefined : [3, 3] }
    });
  }
  axes.forEach((axis, index) => {
    children.push({
      kind: "polyline",
      points: [{ x: cx, y: cy }, at(index, highest)],
      paint: { stroke: theme.groupStroke, strokeWidth: 0.8 }
    });
    const outer = at(index, highest);
    const dx = outer.x - cx;
    const label = {
      x: cx + dx * 1.13,
      y: cy + (outer.y - cy) * 1.13 + (fontSize - 1) * BASELINE_SHIFT
    };
    children.push({
      kind: "text",
      x: label.x,
      y: label.y,
      lines: [{ text: axis, dy: 0 }],
      style: {
        size: fontSize - 1,
        family: fontFamily,
        // Anchored away from the centre so a label never overlaps its own spoke.
        anchor: Math.abs(dx) < 1 ? "middle" : dx > 0 ? "start" : "end",
        fill: theme.edgeText
      }
    });
  });

  diagram.series.forEach((series, index) => {
    const colour = theme.palette[index % theme.palette.length];
    const points = axes.map((_, axis) => at(axis, series.values[axis] ?? 0));
    children.push({
      kind: "polyline",
      closed: true,
      points,
      paint: { fill: { ...colour, a: 0.25 }, stroke: colour, strokeWidth: 2, lineJoin: "round" }
    });
    for (const point of points) {
      children.push({
        kind: "ellipse",
        cx: point.x,
        cy: point.y,
        rx: 3.5,
        ry: 3.5,
        paint: { fill: colour }
      });
    }
    // Legend.
    const legendY = padding + titleHeight + size + 8 + index * fontSize * 1.7;
    children.push(
      ...legendEntry(padding + 4, legendY, colour, series.label, fontSize, fontFamily, theme)
    );
  });

  return { width, height, children };
}

/** Convert an architecture diagram to the flowchart the layout understands. */
export function architectureToFlowchart(diagram: ArchitectureDiagram): FlowchartDiagram {
  const declared = diagram.nodes.filter(node => !node.isGroup);

  // An edge may name a service the source never declared. Filtering it dropped the edge as
  // well, so the connection the author wrote vanished with it.
  const implied: ArchitectureNode[] = [
    ...new Set(diagram.edges.flatMap(edge => [edge.from, edge.to]))
  ]
    // `declared` is a subset of `diagram.nodes`, so testing the latter covers both.
    .filter(id => !diagram.nodes.some(node => node.id === id))
    .map(id => ({ id, label: id, isGroup: false }));
  const services = [...declared, ...implied];
  // `a:R --> L:b` says which sides to leave from, which is a statement about direction: a
  // left/right pair reads across the diagram and a top/bottom pair reads down it. The
  // layered layout cannot honour a per-edge port, but it can be laid out along the axis the
  // ports agree on, which is the part of the intent that survives.
  const sides = diagram.edges.flatMap(edge => [edge.fromSide, edge.toSide]);
  const vertical = sides.filter(side => side === "T" || side === "B").length;
  const horizontal = sides.filter(side => side === "L" || side === "R").length;
  return {
    kind: "flowchart",
    direction: vertical > horizontal ? "TB" : "LR",
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes: services.map(node => ({
      id: node.id,
      // The icon is Mermaid's own registry of names, not something a zero-dependency
      // renderer can draw; naming it beneath the label says what was asked for without
      // pretending to have the glyph.
      text: node.icon === undefined ? node.label : `${node.label}\n(${node.icon})`,
      shape: "round" as const,
      classes: []
    })),
    edges: diagram.edges
      .filter(
        edge => services.some(n => n.id === edge.from) && services.some(n => n.id === edge.to)
      )
      .map(edge => ({
        from: edge.from,
        to: edge.to,
        stroke: "solid" as const,
        startEnd: "none" as const,
        endEnd: edge.arrow ? ("arrow" as const) : ("none" as const),
        minRankSpan: 1
      })),
    subgraphs: diagram.nodes
      .filter(node => node.isGroup)
      .map(group => ({
        id: group.id,
        text: group.label,
        nodeIds: services.filter(node => node.group === group.id).map(node => node.id)
      })),
    classDefs: []
  };
}

/** Draw a laid-out architecture diagram. */
export function architectureNodes(
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const out: DrawNode[] = [];
  for (const route of layout.edges) {
    out.push(...edgeNodes(route, theme));
  }
  for (const box of layout.nodes) {
    const paint: DrawPaint = {
      fill: theme.nodeFill,
      stroke: theme.nodeStroke,
      strokeWidth: 1.5
    };
    out.push({
      kind: "rect",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rx: 8,
      paint
    });
    const step = fontSize * LINE_HEIGHT;
    out.push({
      kind: "text",
      x: box.x + box.width / 2,
      y: box.y + box.height / 2 - ((box.lines.length - 1) * step) / 2 + fontSize * BASELINE_SHIFT,
      lines: box.lines.map((text, index) => ({ text, dy: index * step })),
      style: { size: fontSize, family: fontFamily, anchor: "middle", fill: theme.nodeText }
    });
  }
  out.push(...layoutTitleBlock(layout.title, fontSize, fontFamily, theme));
  return out;
}
