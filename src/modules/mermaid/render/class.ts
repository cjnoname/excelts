/**
 * A class diagram: three-compartment boxes, and relationships whose marks live at the ends.
 *
 * The boxes are measured here rather than by the layout's own pass — a compartment stack is
 * not a centred label — and handed over through `measureNode`, so ranking, ordering,
 * straightening and routing are the same code that lays out a flowchart. Only the drawing
 * differs, which is the part that genuinely differs.
 */

import { measureText } from "@draw/text";
import type { DrawNode, DrawPaint, DrawPoint, DrawTextStyle } from "@draw/types";
import type { FlowLayout, NodeBox } from "@mermaid/layout/flowchart";
import { edgeLabelNodes, edgeNodes } from "@mermaid/render/flowchart";
import { layoutTitleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { ClassBox, ClassDiagram, ClassMember, FlowchartDiagram } from "@mermaid/types";

const LINE_HEIGHT = 1.45;
const BOX_PAD_X = 12;
const COMPARTMENT_PAD = 6;
/** How the four visibilities are written in UML. */
const MARKS: Record<ClassMember["visibility"], string> = {
  public: "+",
  private: "-",
  protected: "#",
  package: "~",
  none: ""
};

/** Convert to the flowchart the layout understands; the boxes keep their own sizes. */
export function classToFlowchart(diagram: ClassDiagram): FlowchartDiagram {
  return {
    kind: "flowchart",
    direction: diagram.direction,
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes: diagram.classes.map(box => ({
      id: box.id,
      text: box.name,
      shape: "rect" as const,
      classes: []
    })),
    edges: diagram.links.map(link => ({
      from: link.from,
      to: link.to,
      // A dependency and a realization are the dashed pair; everything else is solid.
      stroke:
        link.relation === "dependency" || link.relation === "realization"
          ? ("dotted" as const)
          : ("solid" as const),
      startEnd: "none" as const,
      // The end mark is drawn here, not by the flowchart renderer, because UML's marks are
      // its own vocabulary — a hollow triangle, an open or filled diamond.
      endEnd: "none" as const,
      ...(link.label === undefined ? {} : { label: link.label }),
      minRankSpan: 1
    })),
    subgraphs: [],
    classDefs: []
  };
}

/** Measure one class box: a name, then the fields, then the methods. */
export function classNodeSizer(
  diagram: ClassDiagram,
  fontSize: number,
  fontFamily: string
): (node: {
  id: string;
}) => { width: number; height: number; lines: readonly string[] } | undefined {
  const byId = new Map(diagram.classes.map(box => [box.id, box]));
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const memberStyle: DrawTextStyle = { size: fontSize - 1, family: fontFamily };

  return node => {
    const box = byId.get(node.id);
    if (!box) {
      return undefined;
    }
    const lines = boxLines(box);
    const headerLines = box.stereotype === undefined ? 1 : 2;
    const widest = Math.max(
      measureText(box.name, style),
      box.stereotype === undefined ? 0 : measureText(`«${box.stereotype}»`, memberStyle),
      ...lines.slice(headerLines).map(line => measureText(line, memberStyle))
    );
    const fields = box.members.filter(member => !member.method).length;
    const methods = box.members.filter(member => member.method).length;
    // Each populated compartment adds its own padding above and below its rule.
    const compartments = 1 + (fields > 0 ? 1 : 0) + (methods > 0 ? 1 : 0);
    const height =
      headerLines * fontSize * LINE_HEIGHT +
      (fields + methods) * (fontSize - 1) * LINE_HEIGHT +
      compartments * COMPARTMENT_PAD * 2;
    return { width: widest + BOX_PAD_X * 2, height, lines };
  };
}

/** The text of a box, header first. */
function boxLines(box: ClassBox): string[] {
  const lines: string[] = [];
  if (box.stereotype !== undefined) {
    lines.push(`«${box.stereotype}»`);
  }
  lines.push(box.name);
  for (const member of box.members.filter(entry => !entry.method)) {
    lines.push(`${MARKS[member.visibility]}${member.text}`);
  }
  for (const member of box.members.filter(entry => entry.method)) {
    lines.push(`${MARKS[member.visibility]}${member.text}`);
  }
  return lines;
}

/** Draw a laid-out class diagram. */
export function classDiagramNodes(
  diagram: ClassDiagram,
  layout: FlowLayout,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const out: DrawNode[] = [];
  const byId = new Map(diagram.classes.map(box => [box.id, box]));
  // Bound by position, not by endpoints. Keying on `from\0to` let two relationships between
  // the same pair overwrite each other, so an inheritance could be drawn with a composition's
  // diamond — the two marks are the whole difference between the statements.
  const byIndex = diagram.links;

  for (const route of layout.edges) {
    out.push(...edgeNodes(route, theme));
  }
  for (const box of layout.nodes) {
    const model = byId.get(box.id);
    if (model) {
      out.push(...classBoxNodes(model, box, theme, fontSize, fontFamily));
    }
  }
  // Marks and multiplicities on top of the boxes, so a mark meeting a border stays visible.
  layout.edges.forEach((route, index) => {
    const link = byIndex[index];
    if (link !== undefined && link.from === route.edge.from && link.to === route.edge.to) {
      out.push(...relationMarks(route.points, link.relation, theme));
      out.push(...cardinalities(route.points, link, theme, fontSize, fontFamily));
    }
    out.push(...edgeLabelNodes(route, theme, fontSize, fontFamily));
  });
  out.push(...layoutTitleBlock(layout.title, fontSize, fontFamily, theme));
  return out;
}

/** One box: an outline, a header, and a rule above each populated compartment. */
function classBoxNodes(
  model: ClassBox,
  box: NodeBox,
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const paint: DrawPaint = {
    fill: theme.nodeFill,
    stroke: theme.nodeStroke,
    strokeWidth: 1.5
  };
  const out: DrawNode[] = [
    { kind: "rect", x: box.x, y: box.y, width: box.width, height: box.height, rx: 3, paint }
  ];

  const memberSize = fontSize - 1;
  let y = box.y + COMPARTMENT_PAD;

  if (model.stereotype !== undefined) {
    y += fontSize * LINE_HEIGHT;
    out.push(
      textLine(
        `«${model.stereotype}»`,
        box.x + box.width / 2,
        y,
        memberSize,
        fontFamily,
        "middle",
        theme.nodeText
      )
    );
  }
  y += fontSize * LINE_HEIGHT;
  out.push(
    textLine(
      model.name,
      box.x + box.width / 2,
      y,
      fontSize,
      fontFamily,
      "middle",
      theme.nodeText,
      true
    )
  );
  y += COMPARTMENT_PAD;

  const rule = (at: number): DrawNode => ({
    kind: "polyline",
    points: [
      { x: box.x, y: at },
      { x: box.x + box.width, y: at }
    ],
    paint: { stroke: theme.nodeStroke, strokeWidth: 1 }
  });

  for (const group of [false, true]) {
    const members = model.members.filter(member => member.method === group);
    if (members.length === 0) {
      continue;
    }
    out.push(rule(y));
    y += COMPARTMENT_PAD;
    for (const member of members) {
      y += memberSize * LINE_HEIGHT;
      out.push(
        textLine(
          `${MARKS[member.visibility]}${member.text}`,
          box.x + BOX_PAD_X,
          y,
          memberSize,
          fontFamily,
          "start",
          theme.nodeText
        )
      );
    }
    y += COMPARTMENT_PAD;
  }
  return out;
}

function textLine(
  text: string,
  x: number,
  baseline: number,
  size: number,
  family: string,
  anchor: "start" | "middle",
  fill: Theme["nodeText"],
  bold = false
): DrawNode {
  return {
    kind: "text",
    x,
    y: baseline - size * (LINE_HEIGHT - 1) + size * BASELINE_SHIFT - size * 0.5,
    lines: [{ text, dy: 0 }],
    style: { size, family, anchor, fill, ...(bold ? { bold: true } : {}) }
  };
}

/**
 * The mark at the target end of a relationship.
 *
 * UML puts the shape at the end that carries the meaning: the triangle sits on the parent,
 * the diamond on the whole. The parser normalises every arrow so that end is always `to`,
 * which is why only one end is drawn here.
 */
function relationMarks(
  points: readonly DrawPoint[],
  relation: ClassDiagram["links"][number]["relation"],
  theme: Theme
): DrawNode[] {
  const tip = points[points.length - 1];
  const previous = points[points.length - 2];
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
  const at = (back: number, side: number): DrawPoint => ({
    x: tip.x - ux * back - uy * side,
    y: tip.y - uy * back + ux * side
  });

  const outline: DrawPaint = {
    fill: theme.edgeLabelBackground,
    stroke: theme.edge,
    strokeWidth: 1.4
  };
  const solid: DrawPaint = { fill: theme.edge, stroke: theme.edge, strokeWidth: 1.2 };

  switch (relation) {
    case "inheritance":
    case "realization":
      // A hollow triangle, filled with the background so the line behind it does not show.
      return [
        { kind: "polyline", closed: true, points: [tip, at(12, 7), at(12, -7)], paint: outline }
      ];
    case "composition":
      return [
        {
          kind: "polyline",
          closed: true,
          points: [tip, at(8, 6), at(16, 0), at(8, -6)],
          paint: solid
        }
      ];
    case "aggregation":
      return [
        {
          kind: "polyline",
          closed: true,
          points: [tip, at(8, 6), at(16, 0), at(8, -6)],
          paint: outline
        }
      ];
    case "association":
    case "dependency":
      // An open arrowhead: two strokes, not a filled triangle.
      return [
        {
          kind: "polyline",
          points: [at(10, 6), tip, at(10, -6)],
          paint: { stroke: theme.edge, strokeWidth: 1.5, lineCap: "round", lineJoin: "round" }
        }
      ];
    default:
      return [];
  }
}

/** Multiplicities, written just inside each end. */
function cardinalities(
  points: readonly DrawPoint[],
  link: ClassDiagram["links"][number],
  theme: Theme,
  fontSize: number,
  fontFamily: string
): DrawNode[] {
  const out: DrawNode[] = [];
  const place = (text: string, at: DrawPoint, towards: DrawPoint): void => {
    const dx = towards.x - at.x;
    const dy = towards.y - at.y;
    const length = Math.hypot(dx, dy) || 1;
    out.push({
      kind: "text",
      x: at.x + (dx / length) * 16 + (Math.abs(dx) > Math.abs(dy) ? 0 : 12),
      y: at.y + (dy / length) * 16 + (fontSize - 3) * BASELINE_SHIFT,
      lines: [{ text, dy: 0 }],
      style: {
        size: fontSize - 3,
        family: fontFamily,
        anchor: "middle",
        fill: theme.edgeText
      }
    });
  };
  if (link.fromCardinality !== undefined && points.length >= 2) {
    place(link.fromCardinality, points[0], points[1]);
  }
  if (link.toCardinality !== undefined && points.length >= 2) {
    place(link.toCardinality, points[points.length - 1], points[points.length - 2]);
  }
  return out;
}
