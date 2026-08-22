/**
 * `requirementDiagram`, `C4` and `block`.
 *
 * The first two are graphs of boxes, so they are converted to the flowchart form and laid
 * out by the shared passes; what they bring is a box design of their own — a requirement
 * carries its risk and verification method, a C4 element its type and technology.
 *
 * A block diagram is not a graph: its author placed the cells in a grid and the grid *is*
 * the statement. So it is laid out here, in one pass, and only its connections borrow the
 * edge drawing.
 */

import { measureText, wrapText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawTextStyle } from "@draw/types";
import type { FlowLayout, NodeBox } from "@mermaid/layout/flowchart";
import { edgeLabelNodes, edgeNodes, groupNodes } from "@mermaid/render/flowchart";
import { arrowHead, backdrop, layoutTitleBlock, titleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { BlockDiagram, C4Diagram, FlowchartDiagram, RequirementDiagram } from "@mermaid/types";

const LINE_HEIGHT = 1.35;
const PAD_X = 12;
const PAD_Y = 9;
const MAX_LABEL = 190;

/** A box's text, as the rows it will be drawn in. */
interface Rows {
  readonly heading: readonly string[];
  readonly body: readonly string[];
}

/** Convert a requirement diagram to the flowchart the layout understands. */
export function requirementToFlowchart(diagram: RequirementDiagram): FlowchartDiagram {
  const declared = new Set([
    ...diagram.requirements.map(entry => entry.id),
    ...diagram.elements.map(entry => entry.id)
  ]);
  const nodes = [
    ...diagram.requirements.map(entry => ({
      id: entry.id,
      text: entry.name,
      shape: "rect" as const,
      classes: []
    })),
    ...diagram.elements.map(entry => ({
      id: entry.id,
      text: entry.name,
      shape: "rect" as const,
      classes: []
    })),
    // A relationship may name something the source never declared a block for. Dropping it
    // would take the relationship with it and leave the diagram silently incomplete.
    ...[...new Set(diagram.links.flatMap(link => [link.from, link.to]))]
      .filter(id => !declared.has(id))
      .map(id => ({ id, text: id, shape: "rect" as const, classes: [] }))
  ];
  return {
    kind: "flowchart",
    direction: "TB",
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes,
    edges: diagram.links.map(link => ({
      from: link.from,
      to: link.to,
      // `contains` and `copies` are structural; the rest are traces, drawn dashed as UML
      // and SysML both do.
      stroke:
        link.verb === "contains" || link.verb === "copies"
          ? ("solid" as const)
          : ("dotted" as const),
      startEnd: "none" as const,
      endEnd: "arrow" as const,
      label: `«${link.verb}»`,
      minRankSpan: 1
    })),
    subgraphs: [],
    classDefs: []
  };
}

/** Measure a requirement box: a type line, a name, then whatever fields were given. */
export function requirementNodeSizer(
  diagram: RequirementDiagram,
  fontSize: number,
  fontFamily: string
): (node: {
  id: string;
}) => { width: number; height: number; lines: readonly string[] } | undefined {
  const rows = requirementRows(diagram);
  return node => sizeOf(rows.get(node.id), fontSize, fontFamily);
}

/** The rows each requirement or element is drawn with. */
function requirementRows(diagram: RequirementDiagram): Map<string, Rows> {
  const out = new Map<string, Rows>();
  for (const entry of diagram.requirements) {
    const body: string[] = [];
    if (entry.text !== undefined) {
      body.push(entry.text);
    }
    if (entry.risk !== undefined) {
      body.push(`Risk: ${entry.risk}`);
    }
    if (entry.verifyMethod !== undefined) {
      body.push(`Verify: ${entry.verifyMethod}`);
    }
    out.set(entry.id, { heading: [`«${entry.type}»`, entry.name], body });
  }
  for (const entry of diagram.elements) {
    const body: string[] = [];
    if (entry.type !== undefined) {
      body.push(`Type: ${entry.type}`);
    }
    if (entry.docRef !== undefined) {
      body.push(`Ref: ${entry.docRef}`);
    }
    out.set(entry.id, { heading: ["«element»", entry.name], body });
  }
  // Anything a relationship mentions but no block declared still needs a box to sit in.
  for (const link of diagram.links) {
    for (const id of [link.from, link.to]) {
      if (!out.has(id)) {
        out.set(id, { heading: ["", id], body: [] });
      }
    }
  }
  return out;
}

/** Convert a C4 diagram to the flowchart form. */
export function c4ToFlowchart(diagram: C4Diagram): FlowchartDiagram {
  return {
    kind: "flowchart",
    direction: "TB",
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes: diagram.elements.map(element => ({
      id: element.id,
      text: element.label,
      shape: /^person/i.test(element.type) ? ("stadium" as const) : ("rect" as const),
      classes: []
    })),
    edges: diagram.relations.map(relation => ({
      // `Rel_Back` states the same connection from the other end.
      from: relation.reversed ? relation.to : relation.from,
      to: relation.reversed ? relation.from : relation.to,
      stroke: "solid" as const,
      startEnd: "none" as const,
      endEnd: "arrow" as const,
      ...(relation.label === undefined
        ? {}
        : {
            label:
              relation.technology === undefined
                ? relation.label
                : `${relation.label}\n[${relation.technology}]`
          }),
      minRankSpan: 1
    })),
    subgraphs: diagram.boundaries.map(boundary => ({
      id: boundary.id,
      text: boundary.label,
      nodeIds: diagram.elements
        .filter(element => element.boundary === boundary.id)
        .map(element => element.id)
    })),
    classDefs: []
  };
}

/** Measure a C4 box. */
export function c4NodeSizer(
  diagram: C4Diagram,
  fontSize: number,
  fontFamily: string
): (node: {
  id: string;
}) => { width: number; height: number; lines: readonly string[] } | undefined {
  const rows = c4Rows(diagram);
  return node => sizeOf(rows.get(node.id), fontSize, fontFamily);
}

function c4Rows(diagram: C4Diagram): Map<string, Rows> {
  const out = new Map<string, Rows>();
  for (const element of diagram.elements) {
    const heading = [element.label];
    if (element.technology !== undefined) {
      heading.push(`[${element.type}: ${element.technology}]`);
    } else {
      heading.push(`[${element.type}]`);
    }
    out.set(element.id, {
      heading,
      body: element.description === undefined ? [] : [element.description]
    });
  }
  return out;
}

/** Size a box from its rows, wrapping the body. */
function sizeOf(
  rows: Rows | undefined,
  fontSize: number,
  fontFamily: string
): { width: number; height: number; lines: readonly string[] } | undefined {
  if (!rows) {
    return undefined;
  }
  const headStyle: DrawTextStyle = { size: fontSize, family: fontFamily };
  const bodyStyle: DrawTextStyle = { size: fontSize - 2, family: fontFamily };
  const wrapped = rows.body.flatMap(line => wrapText(line, bodyStyle, MAX_LABEL));
  const width =
    Math.max(
      ...rows.heading.map(line => measureText(line, headStyle)),
      ...wrapped.map(line => measureText(line, bodyStyle)),
      70
    ) +
    PAD_X * 2;
  const height =
    rows.heading.length * fontSize * LINE_HEIGHT +
    wrapped.length * (fontSize - 2) * LINE_HEIGHT +
    PAD_Y * 2 +
    (wrapped.length > 0 ? 6 : 0);
  return { width, height, lines: [...rows.heading, ...wrapped] };
}

/** Draw a requirement diagram. */
export function requirementDiagramNodes(
  diagram: RequirementDiagram,
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  return modelNodes(requirementRows(diagram), layout, theme, fontSize, fontFamily, 1);
}

/** Draw a C4 diagram. */
export function c4DiagramNodes(
  diagram: C4Diagram,
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const personIds = new Set(
    diagram.elements.filter(element => /^person/i.test(element.type)).map(element => element.id)
  );
  return modelNodes(c4Rows(diagram), layout, theme, fontSize, fontFamily, 0, personIds);
}

/**
 * The drawing both share: a box with a bold first row, a dimmer type row, and a body.
 *
 * `headingBold` names which of the heading rows is the emphasised one, because a
 * requirement leads with its stereotype and a C4 element leads with its name.
 */
function modelNodes(
  rows: Map<string, Rows>,
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  headingBold: number,
  rounded?: ReadonlySet<string>
): DrawNode[] {
  const out: DrawNode[] = [];
  // Boundaries first: they are a backdrop, and a C4 diagram that parsed one and drew
  // nothing lost the grouping the author had gone out of their way to state.
  for (const group of layout.groups) {
    out.push(...groupNodes(group, theme, fontSize, fontFamily));
  }
  for (const route of layout.edges) {
    out.push(...edgeNodes(route, theme));
  }
  for (const box of layout.nodes) {
    const entry = rows.get(box.id);
    if (entry) {
      out.push(
        ...modelBox(
          entry,
          box,
          theme,
          fontSize,
          fontFamily,
          headingBold,
          rounded?.has(box.id) ?? false
        )
      );
    }
  }
  for (const route of layout.edges) {
    out.push(...edgeLabelNodes(route, theme, fontSize, fontFamily));
  }
  out.push(...layoutTitleBlock(layout.title, fontSize, fontFamily, theme));
  return out;
}

function modelBox(
  rows: Rows,
  box: NodeBox,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  headingBold: number,
  rounded: boolean
): DrawNode[] {
  const paint: DrawPaint = { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.5 };
  const out: DrawNode[] = [
    {
      kind: "rect",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rx: rounded ? box.height / 2 : 4,
      paint
    }
  ];

  let y = box.y + PAD_Y;
  rows.heading.forEach((text, index) => {
    y += fontSize * LINE_HEIGHT;
    out.push({
      kind: "text",
      x: box.x + box.width / 2,
      y: y - fontSize * (LINE_HEIGHT - 1) + fontSize * BASELINE_SHIFT - fontSize * 0.42,
      lines: [{ text, dy: 0 }],
      style: {
        size: index === headingBold ? fontSize : fontSize - 2,
        family: fontFamily,
        anchor: "middle",
        ...(index === headingBold ? { bold: true, fill: theme.nodeText } : { fill: theme.edgeText })
      }
    });
  });

  const body = rows.body.length > 0 ? box.height - (y - box.y) : 0;
  if (body > 0) {
    out.push({
      kind: "polyline",
      points: [
        { x: box.x, y: y + 3 },
        { x: box.x + box.width, y: y + 3 }
      ],
      paint: { stroke: theme.nodeStroke, strokeWidth: 0.8 }
    });
    y += 3;
    for (const text of box.lines.slice(rows.heading.length)) {
      y += (fontSize - 2) * LINE_HEIGHT;
      out.push({
        kind: "text",
        x: box.x + PAD_X,
        y:
          y -
          (fontSize - 2) * (LINE_HEIGHT - 1) +
          (fontSize - 2) * BASELINE_SHIFT -
          (fontSize - 2) * 0.42,
        lines: [{ text, dy: 0 }],
        style: {
          size: fontSize - 2,
          family: fontFamily,
          anchor: "start",
          fill: theme.nodeText
        }
      });
    }
  }
  return out;
}

const CELL_GAP = 12;

/**
 * Draw a block diagram.
 *
 * The grid is the author's statement, so the cells are placed in the order they were
 * written and wrap at the declared column count. A cell that spans several columns takes
 * their width, and a `space` holds a gap open without drawing anything.
 */
export function blockDrawList(
  diagram: BlockDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  if (diagram.cells.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const columnWidth =
    Math.max(...diagram.cells.map(cell => measureText(cell.label, style)), 70) + PAD_X * 2;
  // Sized from the font rather than fixed: a cell has to contain its label, and a constant
  // height meant a larger font simply overflowed the box it was written in.
  const cellHeight = Math.max(40, fontSize * LINE_HEIGHT + PAD_Y * 4);
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;

  // Place the cells, wrapping at the column count.
  interface Placed {
    readonly cell: (typeof diagram.cells)[number];
    readonly x: number;
    readonly y: number;
    readonly width: number;
  }
  const placed: Placed[] = [];
  let column = 0;
  let row = 0;
  for (const cell of diagram.cells) {
    const span = Math.min(cell.span, diagram.columns);
    if (column + span > diagram.columns) {
      column = 0;
      row++;
    }
    placed.push({
      cell,
      x: padding + column * (columnWidth + CELL_GAP),
      y: padding + titleHeight + row * (cellHeight + CELL_GAP),
      width: span * columnWidth + (span - 1) * CELL_GAP
    });
    column += span;
  }

  const width = padding * 2 + diagram.columns * columnWidth + (diagram.columns - 1) * CELL_GAP;
  const height = padding * 2 + titleHeight + (row + 1) * (cellHeight + CELL_GAP) - CELL_GAP;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  const byId = new Map(placed.map(entry => [entry.cell.id, entry]));

  // Connections first, so a line reaching under a border is covered by it.
  for (const edge of diagram.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const a = { x: from.x + from.width / 2, y: from.y + cellHeight / 2 };
    const b = { x: to.x + to.width / 2, y: to.y + cellHeight / 2 };
    children.push({
      kind: "polyline",
      points: [a, b],
      paint: { stroke: theme.edge, strokeWidth: 1.6 }
    });
    if (edge.endEnd === "arrow") {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      // Stop the head on the border rather than at the centre it was aimed at.
      const halfW = to.width / 2;
      const halfH = cellHeight / 2;
      const t = Math.min(
        ux === 0 ? Infinity : halfW / Math.abs(ux),
        uy === 0 ? Infinity : halfH / Math.abs(uy)
      );
      const tip = { x: b.x - ux * t, y: b.y - uy * t };
      // Aim from a point one unit back along the edge rather than from `a`: the two agree
      // wherever the arrow is drawn at all, but a node wider than its own edge would put the
      // tip behind `a` and flip the head round.
      children.push(...arrowHead(tip, { x: tip.x - ux, y: tip.y - uy }, { fill: theme.edge }));
    }
  }

  for (const entry of placed) {
    if (entry.cell.spacer) {
      continue;
    }
    const paint: DrawPaint = { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.5 };
    const { x, y, width: w } = entry;
    const cx = x + w / 2;
    const cy = y + cellHeight / 2;
    switch (entry.cell.shape) {
      case "circle":
        children.push({ kind: "ellipse", cx, cy, rx: w / 2, ry: cellHeight / 2, paint });
        break;
      case "stadium":
        children.push({
          kind: "rect",
          x,
          y,
          width: w,
          height: cellHeight,
          rx: cellHeight / 2,
          paint
        });
        break;
      case "rhombus":
        children.push({
          kind: "polyline",
          closed: true,
          points: [
            { x: cx, y },
            { x: x + w, y: cy },
            { x: cx, y: y + cellHeight },
            { x, y: cy }
          ],
          paint
        });
        break;
      case "hexagon": {
        const cut = Math.min(16, w / 5);
        children.push({
          kind: "polyline",
          closed: true,
          points: [
            { x: x + cut, y },
            { x: x + w - cut, y },
            { x: x + w, y: cy },
            { x: x + w - cut, y: y + cellHeight },
            { x: x + cut, y: y + cellHeight },
            { x, y: cy }
          ],
          paint
        });
        break;
      }
      case "subroutine":
        children.push({ kind: "rect", x, y, width: w, height: cellHeight, paint });
        for (const inset of [8, w - 8]) {
          children.push({
            kind: "polyline",
            points: [
              { x: x + inset, y },
              { x: x + inset, y: y + cellHeight }
            ],
            paint: { stroke: theme.nodeStroke, strokeWidth: 1.5 }
          });
        }
        break;
      case "asymmetric": {
        const point = Math.min(14, w / 5);
        children.push({
          kind: "polyline",
          closed: true,
          points: [
            { x, y },
            { x: x + w - point, y },
            { x: x + w, y: cy },
            { x: x + w - point, y: y + cellHeight },
            { x, y: y + cellHeight }
          ],
          paint
        });
        break;
      }
      default:
        // Every shape the parser can produce has a branch; anything else is a box, which is
        // what an unrecognised bracket pair means.
        children.push({ kind: "rect", x, y, width: w, height: cellHeight, rx: 4, paint });
    }
    children.push({
      kind: "text",
      x: cx,
      y: cy + fontSize * BASELINE_SHIFT,
      lines: [{ text: entry.cell.label, dy: 0 }],
      style: { size: fontSize, family: fontFamily, anchor: "middle", fill: theme.nodeText }
    });
  }

  return { width, height, children };
}
