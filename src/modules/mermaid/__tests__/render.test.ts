/**
 * Layout and paint.
 *
 * These assert the properties a reader depends on — a trunk that runs straight, an
 * arrowhead that lands on a border rather than under it, a back edge that does not cross
 * the nodes between its ends — rather than exact coordinates, which would have to be
 * rewritten by hand every time a margin changes and would say nothing about whether the
 * picture is right.
 */
import { rasterizeToRgba, toSvg } from "@draw/index";
import { renderDrawList } from "@draw/render";
import type { DrawNode, DrawPaint } from "@draw/types";
import { layoutFlowchart, mermaidToDrawList, mermaidToSvg, parseMermaid } from "@mermaid/index";
import type { FlowchartDiagram } from "@mermaid/types";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { createPdfDrawSurface } from "@pdf/render/draw-surface";
import { describe, expect, it } from "vitest";

const layout = (source: string) => layoutFlowchart(parseMermaid(source) as FlowchartDiagram);
const centre = (box: { x: number; width: number }): number => box.x + box.width / 2;
const nodeById = (result: ReturnType<typeof layout>, id: string) =>
  result.nodes.find(node => node.id === id)!;

/**
 * Whether a segment touches a box.
 *
 * Sampled rather than solved: an exact clip is a well-known routine, but a wrong one would
 * pass a broken layout, and a sample every couple of units cannot miss a node whose
 * smallest dimension is thirty.
 */
function segmentHitsBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number }
): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height) {
      return true;
    }
  }
  return false;
}

describe("layout", () => {
  it("ranks a chain one step at a time", () => {
    const result = layout("flowchart TD\n A --> B --> C");
    const ys = result.nodes.map(node => node.y);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
  });

  it("runs a chain straight down the middle", () => {
    // Straightening pushes right to clear an overlap, which drags the whole rank sideways
    // unless it is re-centred afterwards; the fork below then pulls the trunk after it and
    // the diagram visibly bends. Every node of the trunk has to agree, not just a pair of
    // them: two adjacent single-node ranks match each other even while both drift.
    const result = layout(`flowchart TD
      A[Start] --> B[Then] --> C{Choice}
      C -->|one| D[Laptop]
      C -->|two| E[Phone]
      C -->|three| F[Car]`);
    // Within a unit: the relaxation converges rather than terminating exactly, and a
    // sub-pixel residue is not a bend. A rank dragged by an un-centred push lands tens of
    // units away, which is what this has to catch.
    const trunk = ["A", "B", "C"].map(id => centre(nodeById(result, id)));
    expect(Math.abs(trunk[1] - trunk[0])).toBeLessThan(1);
    expect(Math.abs(trunk[2] - trunk[0])).toBeLessThan(1);
  });

  it("places siblings symmetrically about their parent", () => {
    const result = layout(`flowchart TD
      A --> B
      A --> C`);
    const parent = centre(nodeById(result, "A"));
    const left = centre(nodeById(result, "B"));
    const right = centre(nodeById(result, "C"));
    expect(parent - left).toBeCloseTo(right - parent, 1);
  });

  it("advances along X when the direction is horizontal", () => {
    const result = layout("flowchart LR\n A --> B");
    expect(nodeById(result, "A").x).toBeLessThan(nodeById(result, "B").x);
    expect(nodeById(result, "A").y).toBeCloseTo(nodeById(result, "B").y, 1);
  });

  it("honours a longer link by leaving more room", () => {
    const near = layout("flowchart TD\n A --> B");
    const far = layout("flowchart TD\n A ----> B");
    expect(nodeById(far, "B").y).toBeGreaterThan(nodeById(near, "B").y);
  });

  it("gives a cycle a layering instead of failing to find one", () => {
    // No layering satisfies every edge of a cycle, so the back edge is left out of the
    // ranking; it still gets drawn, it just does not get a vote.
    const result = layout(`flowchart TD
      A --> B
      B --> C
      C --> A`);
    expect(result.nodes).toHaveLength(3);
    expect(nodeById(result, "A").y).toBeLessThan(nodeById(result, "C").y);
  });

  it("keeps every node inside the reported bounds", () => {
    const result = layout(`flowchart TD
      A[Start] --> B{Choice}
      B -->|yes| C[Left]
      B -->|no| D[Right]
      C --> E[End]
      D --> E`);
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(result.width);
      expect(node.y + node.height).toBeLessThanOrEqual(result.height);
    }
  });

  it("wraps a long label instead of letting it decide the diagram's width", () => {
    const result = layout(
      "flowchart TD\n A[a label long enough that it has to be broken across lines] --> B"
    );
    expect(nodeById(result, "A").lines.length).toBeGreaterThan(1);
  });

  it("frames a subgraph around its members", () => {
    const result = layout(`flowchart TB
      subgraph g [G]
        A --> B
      end
      B --> C`);
    const frame = result.groups[0];
    for (const id of ["A", "B"]) {
      const node = nodeById(result, id);
      expect(node.x).toBeGreaterThanOrEqual(frame.x);
      expect(node.x + node.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(node.y + node.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    // The node outside the group must not be swept into its frame.
    expect(nodeById(result, "C").y).toBeGreaterThan(frame.y + frame.height);
  });
});

describe("edge routing", () => {
  it("stops an edge on the border, not inside the box", () => {
    const result = layout("flowchart TD\n A --> B");
    const target = nodeById(result, "B");
    const end = result.edges[0].points.at(-1)!;
    expect(end.y).toBeCloseTo(target.y, 0);
  });

  it("meets a rhombus on its slope rather than on its bounding box", () => {
    // A diamond's border sits well inside the box it reserves, so a line clipped to the
    // box would stop short and the arrowhead would float.
    const result = layout("flowchart TD\n A --> B{a wide decision label}");
    const end = result.edges[0].points.at(-1)!;
    const box = nodeById(result, "B");
    expect(end.y).toBeCloseTo(box.y, 0);
    expect(end.x).toBeCloseTo(box.x + box.width / 2, 0);
  });

  it("routes a back edge outside the nodes it would otherwise cross", () => {
    // Drawn straight, `C --> A` passes through B, and the piece that shows is the segment
    // between A and B — which reads as an arrowhead neither edge asked for.
    const result = layout(`flowchart TD
      A --> B
      B --> C
      C --> A`);
    const back = result.edges.find(edge => edge.edge.from === "C" && edge.edge.to === "A")!;
    const middle = nodeById(result, "B");
    // Segment against box, not vertex inside box: a straight line from C to A has both of
    // its endpoints on *other* borders and still runs clean through the middle node.
    const crosses = back.points
      .slice(1)
      .some((point, index) => segmentHitsBox(back.points[index], point, middle));
    expect(crosses).toBe(false);
  });

  it("loops a self-edge rather than collapsing it to a point", () => {
    const result = layout("flowchart TD\n A --> A");
    const points = result.edges[0].points;
    expect(points.length).toBeGreaterThan(2);
    expect(points[0]).not.toEqual(points.at(-1));
  });

  it("puts a label on the line it belongs to", () => {
    const result = layout("flowchart TD\n A -->|yes| B");
    const label = result.edges[0].label!;
    const a = nodeById(result, "A");
    const b = nodeById(result, "B");
    expect(label.y).toBeGreaterThan(a.y + a.height);
    expect(label.y).toBeLessThan(b.y);
  });
});

describe("a diagram must not claim more than its source did", () => {
  /** Nodes whose box overlaps a group's frame. */
  const inside = (result: ReturnType<typeof layout>, groupId: string): string[] => {
    const frame = result.groups.find(group => group.id === groupId)!;
    return result.nodes
      .filter(
        node =>
          node.x + node.width > frame.x &&
          node.x < frame.x + frame.width &&
          node.y + node.height > frame.y &&
          node.y < frame.y + frame.height
      )
      .map(node => node.id);
  };

  it("keeps a stranger out of a subgraph that shares its ranks", () => {
    // A frame is drawn around the extent of its members, and that extent is
    // two-dimensional: ordering members next to each other is not enough, because the
    // frame spans several ranks and an outsider in any of them falls inside it. The
    // picture then states a membership the source never did.
    expect(
      inside(
        layout(`flowchart TB
          subgraph g [Group]
            A --> B
          end
          X[Outsider] --> B`),
        "g"
      )
    ).toEqual(["A", "B"]);
  });

  it("keeps a stranger out from between two members", () => {
    expect(
      inside(
        layout(`flowchart TB
          Root --> A
          Root --> X
          Root --> B
          subgraph g [Group]
            A
            B
          end`),
        "g"
      )
    ).toEqual(["A", "B"]);
  });
});

describe("edges that would otherwise coincide", () => {
  const paths = (source: string): string[] =>
    layout(source).edges.map(route =>
      route.points.map(point => `${Math.round(point.x)},${Math.round(point.y)}`).join(" ")
    );

  it("fans out two links between the same pair", () => {
    // Identical geometry draws them on top of each other, and one label hides the other.
    // Measured as a real gap between the two paths at their midpoints: comparing the
    // point lists alone passes as soon as they differ in *shape*, which they do even
    // when both still run down the same line.
    const routes = layout("flowchart TD\n A -->|one| B\n A -->|two| B").edges;
    const midX = routes.map(route => route.label!.x + route.label!.width / 2);
    expect(Math.abs(midX[0] - midX[1])).toBeGreaterThan(8);
  });

  it("keeps every strand of a fan touching both borders", () => {
    // The attachments are spread too — sharing one leaves every sibling's arrowhead on the
    // same pixel — but each must still land *on* its node, not beside it.
    const result = layout("flowchart TD\n A --> B\n A --> B\n A --> B");
    const a = nodeById(result, "A");
    const b = nodeById(result, "B");
    const on = (point: { x: number; y: number }, box: typeof a): boolean =>
      point.x >= box.x - 0.5 &&
      point.x <= box.x + box.width + 0.5 &&
      point.y >= box.y - 0.5 &&
      point.y <= box.y + box.height + 0.5;
    for (const route of result.edges) {
      expect(on(route.points[0], a)).toBe(true);
      expect(on(route.points.at(-1)!, b)).toBe(true);
    }
    // And no two strands may start from the same place.
    const starts = new Set(result.edges.map(route => Math.round(route.points[0].x)));
    expect(starts.size).toBe(result.edges.length);
  });

  it("gives each detour its own lane", () => {
    // Back edges are the ones that still go round; a forward edge that skips a rank now
    // threads through the lane its dummies held open.
    const routes = layout("flowchart TD\n A --> B --> C\n C --> A\n C --> B").edges;
    const lanes = routes
      .filter(route => route.points.length === 4)
      .map(route => Math.round(route.points[1].x));
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("threads a skip edge through the diagram instead of around it", () => {
    // Without dummies a long edge has no say in how the ranks between its ends are ordered,
    // so it has to be routed afterwards around everything — which is why a diagram with
    // several of them grew a bundle of lanes down its margin.
    const result = layout("flowchart TD\n A --> B --> C --> D\n A --> D");
    const skip = result.edges.find(route => route.edge.from === "A" && route.edge.to === "D")!;
    const inside = skip.points.every(
      point => point.x > 0 && point.x < result.width && point.y > 0 && point.y < result.height
    );
    expect(inside).toBe(true);
    // One bend per rank it passes through, rather than a trip round the outside.
    expect(skip.points.length).toBeGreaterThanOrEqual(4);
  });

  it("separates two self-loops on the same node", () => {
    const [first, second] = paths("flowchart TD\n A --> A\n A --> A");
    expect(first).not.toBe(second);
  });
});

describe("the display list", () => {
  it("draws an arrowhead as a closed triangle, which every backend already has", () => {
    // A marker is an SVG-only concept; the producer lowers it so nothing had to be added
    // to the IR for this diagram type.
    const list = mermaidToDrawList("flowchart TD\n A --> B");
    const triangles = list.children.filter(
      node => node.kind === "polyline" && node.closed === true && node.points.length === 3
    );
    expect(triangles).toHaveLength(1);
  });

  it("uses only primitives the engine already had", () => {
    const list = mermaidToDrawList(`flowchart TD
      A[(db)] --> B{choice}
      B --> C((circle))`);
    const kinds = new Set(list.children.map(node => node.kind));
    for (const kind of kinds) {
      expect(["rect", "ellipse", "polyline", "path", "text", "line", "sector", "group"]).toContain(
        kind
      );
    }
  });

  it("dashes a dotted link and thickens a thick one", () => {
    const dotted = mermaidToDrawList("flowchart LR\n A -.-> B");
    const thick = mermaidToDrawList("flowchart LR\n A ==> B");
    const strokeOf = (list: ReturnType<typeof mermaidToDrawList>): DrawPaint => {
      const found = list.children.find(
        (node): node is Extract<DrawNode, { kind: "polyline" }> =>
          node.kind === "polyline" && node.paint.stroke !== undefined
      );
      return found!.paint;
    };
    expect(strokeOf(dotted).dash).toBeDefined();
    expect(strokeOf(thick).strokeWidth).toBeGreaterThan(
      strokeOf(mermaidToDrawList("flowchart LR\n A --> B")).strokeWidth!
    );
  });

  it("applies a classDef to the node that carries the class", () => {
    const list = mermaidToDrawList(`flowchart LR
      A --> B:::hot
      classDef hot fill:#ff0000`);
    const red = list.children.filter(
      node => node.kind === "rect" && node.paint.fill?.r === 1 && node.paint.fill?.g === 0
    );
    expect(red).toHaveLength(1);
  });

  it("draws an edge label above the node it would otherwise hide behind", () => {
    // Labels are emitted after the nodes; drawn with their edge they sat underneath.
    const list = mermaidToDrawList("flowchart TD\n A -->|yes| B");
    const lastText = list.children.map(node => node.kind).lastIndexOf("text");
    const lastRect = list.children.map(node => node.kind).lastIndexOf("rect");
    expect(lastText).toBeGreaterThan(lastRect - 2);
  });
});

describe("every backend draws the same diagram", () => {
  const source = `flowchart TD
    A[Start] --> B{Choice}
    B -->|yes| C[(Store)]
    B -->|no| D((Stop))`;

  it("renders to markup, pixels and page operators from one list", () => {
    const list = mermaidToDrawList(source, { background: "#ffffff" });

    const svg = toSvg(list);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<text");

    const image = rasterizeToRgba(list, { width: list.width, height: list.height });
    expect(image.data).toHaveLength(image.width * image.height * 4);
    expect([...image.data].some(channel => channel > 0)).toBe(true);

    const page = new PdfDocumentBuilder().addPage({ width: list.width, height: list.height });
    renderDrawList(
      list,
      createPdfDrawSurface(page, { x: 0, y: 0, width: list.width, height: list.height })
    );
    const stream = page.getContentStream().toString();
    expect(stream).toMatch(/ re$/m);
    expect(stream).toMatch(/Tj$/m);
  });

  it("puts the same number of glyphs in the SVG as the diagram has labels", () => {
    const svg = mermaidToSvg(source);
    const texts = (svg.match(/<text/g) ?? []).length;
    // Four node labels and two edge labels.
    expect(texts).toBe(6);
  });

  it("leaves the list transparent unless a background is asked for", () => {
    expect(mermaidToDrawList(source).children[0].kind).not.toBe("rect");
    expect(mermaidToDrawList(source, { background: "#fff" }).children[0].kind).toBe("rect");
  });
});

describe("pie and sequence", () => {
  it("draws one sector per slice", () => {
    const list = mermaidToDrawList('pie\n "A" : 60\n "B" : 40');
    expect(list.children.filter(node => node.kind === "sector")).toHaveLength(2);
  });

  it("drops a slice with no positive value rather than drawing a zero-width wedge", () => {
    const list = mermaidToDrawList('pie\n "A" : 60\n "B" : 0\n "C" : -5');
    expect(list.children.filter(node => node.kind === "sector")).toHaveLength(1);
  });

  it("repeats a sequence diagram's headers at the foot", () => {
    const list = mermaidToDrawList("sequenceDiagram\n A->>B: hi");
    const labels = list.children.filter(
      node => node.kind === "text" && (node.lines[0].text === "A" || node.lines[0].text === "B")
    );
    expect(labels).toHaveLength(4);
  });

  it("gives every message a lifeline to travel between", () => {
    const list = mermaidToDrawList("sequenceDiagram\n A->>B: one\n B-->>A: two");
    const dashed = list.children.filter(
      node => node.kind === "polyline" && node.paint.dash !== undefined
    );
    // Two lifelines, plus the dotted reply.
    expect(dashed.length).toBeGreaterThanOrEqual(2);
  });
});
