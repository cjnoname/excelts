/**
 * An entity-relationship diagram: attribute tables joined by crow's-foot lines.
 *
 * Like the class diagram, the boxes are measured here and laid out by the shared passes.
 * What is specific is the notation at the ends: a crow's foot for "many", a bar for "one",
 * a circle for "zero", drawn a short way back from the border so both marks of a compound
 * cardinality — the circle *and* the foot — are legible.
 */

import { measureText } from "@draw/text";
import type { DrawNode, DrawPaint, DrawPoint, DrawTextStyle } from "@draw/types";
import type { FlowLayout, NodeBox } from "@mermaid/layout/flowchart";
import { edgeLabelNodes, edgeNodes } from "@mermaid/render/flowchart";
import { layoutTitleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { Cardinality, Entity, ErDiagram, FlowchartDiagram } from "@mermaid/types";

const ROW_HEIGHT = 1.55;
const CELL_PAD = 10;
/** How far back from the border the notation is drawn. */
const FOOT_BACK = 4;
const FOOT_LENGTH = 12;
const FOOT_HALF = 6;

/** Convert to the flowchart the layout understands. */
export function erToFlowchart(diagram: ErDiagram): FlowchartDiagram {
  return {
    kind: "flowchart",
    direction: diagram.direction,
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes: diagram.entities.map(entity => ({
      id: entity.id,
      text: entity.name,
      shape: "rect" as const,
      classes: []
    })),
    edges: diagram.relations.map(relation => ({
      from: relation.from,
      to: relation.to,
      stroke: relation.identifying ? ("solid" as const) : ("dotted" as const),
      startEnd: "none" as const,
      endEnd: "none" as const,
      ...(relation.label === undefined ? {} : { label: relation.label }),
      minRankSpan: 1
    })),
    subgraphs: [],
    classDefs: []
  };
}

/** Measure one entity: a header row, then one row per attribute. */
export function erNodeSizer(
  diagram: ErDiagram,
  fontSize: number,
  fontFamily: string
): (node: {
  id: string;
}) => { width: number; height: number; lines: readonly string[] } | undefined {
  const byId = new Map(diagram.entities.map(entity => [entity.id, entity]));
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const cellStyle: DrawTextStyle = { size: fontSize - 2, family: fontFamily };

  return node => {
    const entity = byId.get(node.id);
    if (!entity) {
      return undefined;
    }
    const columns = columnWidths(entity, cellStyle);
    const body = columns.reduce((sum, width) => sum + width + CELL_PAD * 2, 0);
    const width = Math.max(measureText(entity.name, style) + CELL_PAD * 4, body, 110);
    const height =
      fontSize * ROW_HEIGHT + 8 + entity.attributes.length * (fontSize - 2) * ROW_HEIGHT;
    return { width, height, lines: [entity.name] };
  };
}

/**
 * Widths of the four columns: type, name, keys, comment.
 *
 * The comment is a column like any other. Measuring three and drawing three meant an
 * attribute's `"…"` note parsed, sized nothing and appeared nowhere.
 */
function columnWidths(entity: Entity, style: DrawTextStyle): [number, number, number, number] {
  let type = 0;
  let name = 0;
  let keys = 0;
  let comment = 0;
  for (const attribute of entity.attributes) {
    type = Math.max(type, measureText(attribute.type, style));
    name = Math.max(name, measureText(attribute.name, style));
    keys = Math.max(keys, measureText(attribute.keys.join(", "), style));
    comment = Math.max(comment, measureText(attribute.comment ?? "", style));
  }
  return [type, name, keys, comment];
}

/** Draw a laid-out entity-relationship diagram. */
export function erDiagramNodes(
  diagram: ErDiagram,
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const out: DrawNode[] = [];
  const byId = new Map(diagram.entities.map(entity => [entity.id, entity]));
  // Bound by position: two relationships between the same pair would otherwise share one
  // set of cardinalities, and a crow's foot then states a multiplicity nobody wrote.
  const byIndex = diagram.relations;

  for (const route of layout.edges) {
    out.push(...edgeNodes(route, theme));
  }
  for (const box of layout.nodes) {
    const entity = byId.get(box.id);
    if (entity) {
      out.push(...entityNodes(entity, box, theme, fontSize, fontFamily));
    }
  }
  layout.edges.forEach((route, index) => {
    const relation = byIndex[index];
    if (
      relation !== undefined &&
      relation.from === route.edge.from &&
      relation.to === route.edge.to
    ) {
      out.push(...crowsFoot(route.points, relation.toCardinality, false, theme));
      out.push(...crowsFoot(route.points, relation.fromCardinality, true, theme));
    }
    out.push(...edgeLabelNodes(route, theme, fontSize, fontFamily));
  });
  out.push(...layoutTitleBlock(layout.title, fontSize, fontFamily, theme));
  return out;
}

/** One entity: a titled header over a table of attributes. */
function entityNodes(
  entity: Entity,
  box: NodeBox,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const headerHeight = fontSize * ROW_HEIGHT + 8;
  const cellSize = fontSize - 2;
  const out: DrawNode[] = [
    {
      kind: "rect",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rx: 3,
      paint: { fill: theme.edgeLabelBackground, stroke: theme.nodeStroke, strokeWidth: 1.5 }
    },
    {
      kind: "rect",
      x: box.x,
      y: box.y,
      width: box.width,
      height: headerHeight,
      rx: 3,
      paint: { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.5 }
    },
    {
      kind: "text",
      x: box.x + box.width / 2,
      y: box.y + headerHeight / 2 + fontSize * BASELINE_SHIFT,
      lines: [{ text: entity.name, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "middle",
        bold: true,
        fill: theme.nodeText
      }
    }
  ];

  const columns = columnWidths(entity, { size: cellSize, family: fontFamily });
  let y = box.y + headerHeight;
  entity.attributes.forEach((attribute, index) => {
    if (index > 0) {
      out.push({
        kind: "polyline",
        points: [
          { x: box.x, y },
          { x: box.x + box.width, y }
        ],
        paint: { stroke: theme.nodeStroke, strokeWidth: 0.6 }
      });
    }
    const baseline = y + (cellSize * ROW_HEIGHT) / 2 + cellSize * BASELINE_SHIFT;
    let x = box.x + CELL_PAD;
    for (const [cell, width, italic] of [
      [attribute.type, columns[0], true],
      [attribute.name, columns[1], false],
      [attribute.keys.join(", "), columns[2], false],
      [attribute.comment ?? "", columns[3], true]
    ] as Array<[string, number, boolean]>) {
      if (cell !== "") {
        out.push({
          kind: "text",
          x,
          y: baseline,
          lines: [{ text: cell, dy: 0 }],
          style: {
            size: cellSize,
            family: fontFamily,
            anchor: "start",
            fill: theme.nodeText,
            ...(italic ? { italic: true } : {})
          }
        });
      }
      x += width + CELL_PAD * 2;
    }
    y += cellSize * ROW_HEIGHT;
  });

  return out;
}

/**
 * The crow's-foot notation at one end.
 *
 * Two marks in the general case — a circle or a bar for the minimum, a foot or a bar for
 * the maximum — so they are placed at two distances from the border and never collide.
 */
function crowsFoot(
  points: readonly DrawPoint[],
  cardinality: Cardinality,
  atStart: boolean,
  theme: Theme
): DrawNode[] {
  const tip = atStart ? points[0] : points[points.length - 1];
  const towards = atStart ? points[1] : points[points.length - 2];
  if (!tip || !towards) {
    return [];
  }
  const dx = towards.x - tip.x;
  const dy = towards.y - tip.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [];
  }
  // Unit vector pointing away from the entity, along the line.
  const ux = dx / length;
  const uy = dy / length;
  const at = (back: number, side: number): DrawPoint => ({
    x: tip.x + ux * back - uy * side,
    y: tip.y + uy * back + ux * side
  });
  const paint: DrawPaint = { stroke: theme.edge, strokeWidth: 1.5, lineCap: "round" };

  const out: DrawNode[] = [];
  const many = cardinality === "zeroOrMore" || cardinality === "oneOrMore";
  const optional = cardinality === "zeroOrOne" || cardinality === "zeroOrMore";

  if (many) {
    // Three lines from a point on the border, spreading back along the edge.
    const spread = at(FOOT_LENGTH + FOOT_BACK, 0);
    out.push({
      kind: "polyline",
      points: [at(FOOT_BACK, 0), at(FOOT_LENGTH + FOOT_BACK, FOOT_HALF)],
      paint
    });
    out.push({
      kind: "polyline",
      points: [at(FOOT_BACK, 0), at(FOOT_LENGTH + FOOT_BACK, -FOOT_HALF)],
      paint
    });
    out.push({ kind: "polyline", points: [at(FOOT_BACK, 0), spread], paint });
  } else {
    // A bar across the line marks "one". `exactlyOne` is minimum *and* maximum one, which
    // crow's-foot notation writes as two bars — one bar alone reads as "one or more".
    out.push({
      kind: "polyline",
      points: [at(FOOT_BACK + 6, FOOT_HALF), at(FOOT_BACK + 6, -FOOT_HALF)],
      paint
    });
    if (cardinality === "exactlyOne") {
      out.push({
        kind: "polyline",
        points: [at(FOOT_BACK + 12, FOOT_HALF), at(FOOT_BACK + 12, -FOOT_HALF)],
        paint
      });
    }
  }

  if (optional) {
    // A circle for "zero", set beyond the other mark.
    const centre = at(FOOT_LENGTH + FOOT_BACK + (many ? 6 : 2), 0);
    out.push({
      kind: "ellipse",
      cx: centre.x,
      cy: centre.y,
      rx: 4.5,
      ry: 4.5,
      paint: { fill: theme.edgeLabelBackground, stroke: theme.edge, strokeWidth: 1.4 }
    });
  } else if (many) {
    // A bar for "one or more", inside the foot.
    const bar = at(FOOT_LENGTH + FOOT_BACK + 5, 0);
    out.push({
      kind: "polyline",
      points: [
        { x: bar.x - uy * FOOT_HALF, y: bar.y + ux * FOOT_HALF },
        { x: bar.x + uy * FOOT_HALF, y: bar.y - ux * FOOT_HALF }
      ],
      paint
    });
  }
  return out;
}
