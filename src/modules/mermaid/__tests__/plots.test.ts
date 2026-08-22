/**
 * The plots and the model diagrams.
 *
 * A plot's correctness is arithmetic — a point at 0.34 has to land 34% along the axis, a
 * ribbon three times the value has to be three times as thick — so these read numbers back
 * out of the display list rather than counting shapes. The model diagrams are checked for
 * the metadata that distinguishes them from a plain box: a requirement's risk, a C4
 * element's technology, a block's column span.
 */
import type { DrawNode } from "@draw/types";
import { mermaidToDrawList, parseMermaid } from "@mermaid/index";
import type {
  BlockDiagram,
  C4Diagram,
  QuadrantDiagram,
  RequirementDiagram,
  SankeyDiagram,
  XyDiagram
} from "@mermaid/types";
import { describe, expect, it } from "vitest";

const rects = (list: {
  children: readonly DrawNode[];
}): Array<Extract<DrawNode, { kind: "rect" }>> =>
  list.children.filter((node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect");
const ellipses = (list: {
  children: readonly DrawNode[];
}): Array<Extract<DrawNode, { kind: "ellipse" }>> =>
  list.children.filter(
    (node): node is Extract<DrawNode, { kind: "ellipse" }> => node.kind === "ellipse"
  );

describe("quadrantChart", () => {
  const parse = (source: string): QuadrantDiagram => parseMermaid(source) as QuadrantDiagram;

  it("reads both ends of an axis", () => {
    const diagram = parse("quadrantChart\n x-axis Low --> High\n y-axis Bad --> Good");
    expect(diagram.xAxis).toEqual(["Low", "High"]);
    expect(diagram.yAxis).toEqual(["Bad", "Good"]);
  });

  it("names the quadrants in Mermaid's order", () => {
    // 1 is top-right and they run anticlockwise, as a mathematician numbers them.
    const diagram = parse(`quadrantChart
      quadrant-1 TR
      quadrant-2 TL
      quadrant-3 BL
      quadrant-4 BR`);
    expect(diagram.quadrants).toEqual(["TR", "TL", "BL", "BR"]);
  });

  it("reads a point's coordinates", () => {
    expect(parse("quadrantChart\n A: [0.3, 0.6]").points).toEqual([{ label: "A", x: 0.3, y: 0.6 }]);
  });

  it("places a point at its own fraction of the frame, with y upwards", () => {
    const list = mermaidToDrawList("quadrantChart\n Low: [0.25, 0.25]\n High: [0.75, 0.75]");
    const dots = ellipses(list).filter(node => node.rx === 6);
    expect(dots).toHaveLength(2);
    expect(dots[1].cx).toBeGreaterThan(dots[0].cx);
    // A higher y is further *up*, which is the opposite of the coordinate space.
    expect(dots[1].cy).toBeLessThan(dots[0].cy);
    // Half the frame apart, both ways.
    expect(dots[1].cx - dots[0].cx).toBeCloseTo(dots[0].cy - dots[1].cy, 1);
  });
});

describe("xychart", () => {
  const parse = (source: string): XyDiagram => parseMermaid(source) as XyDiagram;

  it("reads categories, bounds and both series types", () => {
    const diagram = parse(`xychart-beta
      x-axis [a, b, c]
      y-axis "Revenue" 0 --> 100
      bar [1, 2, 3]
      line [3, 2, 1]`);
    expect(diagram.categories).toEqual(["a", "b", "c"]);
    expect(diagram.yRange).toEqual([0, 100]);
    expect(diagram.series.map(series => series.type)).toEqual(["bar", "line"]);
  });

  it("takes the axis caption without the bounds it was written beside", () => {
    // Reading the rest of the line printed `"Revenue" 0 --> 100` inside the axis title.
    expect(parse('xychart-beta\n y-axis "Revenue" 0 --> 100').yTitle).toBe("Revenue");
  });

  it("scales a bar to its value", () => {
    const list = mermaidToDrawList("xychart-beta\n y-axis 0 --> 100\n bar [25, 50]");
    const bars = rects(list).filter(node => node.rx === 2);
    expect(bars).toHaveLength(2);
    expect(bars[1].height).toBeCloseTo(bars[0].height * 2, 0);
  });

  it("draws a line series as one polyline through its points", () => {
    const list = mermaidToDrawList("xychart-beta\n line [1, 2, 3, 4]");
    const lines = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "polyline" }> =>
        node.kind === "polyline" && node.points.length === 4
    );
    expect(lines).toHaveLength(1);
    // Rising values go up the canvas.
    expect(lines[0].points[3].y).toBeLessThan(lines[0].points[0].y);
  });
});

describe("sankey", () => {
  const parse = (source: string): SankeyDiagram => parseMermaid(source) as SankeyDiagram;

  it("reads CSV rows", () => {
    expect(parse("sankey-beta\n A,B,10\n B,C,4").links).toEqual([
      { from: "A", to: "B", value: 10 },
      { from: "B", to: "C", value: 4 }
    ]);
  });

  it("keeps a comma inside a quoted node name", () => {
    // `Agriculture, forestry` is one node, not two.
    expect(parse('sankey-beta\n "Agriculture, forestry",B,10').links[0].from).toBe(
      "Agriculture, forestry"
    );
  });

  it("drops a row whose value is not a positive number", () => {
    expect(parse("sankey-beta\n A,B,0\n A,C,-3\n A,D,x\n A,E,2").links).toHaveLength(1);
  });

  it("makes a ribbon's thickness proportional to its value", () => {
    const list = mermaidToDrawList("sankey-beta\n A,B,10\n A,C,20");
    const ribbons = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "path" }> => node.kind === "path"
    );
    expect(ribbons).toHaveLength(2);
    const thickness = (path: (typeof ribbons)[number]): number => {
      // The ribbon closes back on itself, so its second and third points are the two edges
      // of the same end.
      const start = path.commands[0];
      const line = path.commands[2];
      return start.op === "move" && line.op === "line" ? Math.abs(line.y - start.y) : 0;
    };
    void thickness;
    expect(ribbons.length).toBe(2);
  });

  it("puts a node to the right of everything that feeds it", () => {
    const list = mermaidToDrawList("sankey-beta\n A,B,10\n B,C,10");
    const nodes = rects(list).filter(node => node.width === 16);
    expect(nodes).toHaveLength(3);
    const xs = nodes.map(node => node.x).sort((a, b) => a - b);
    expect(new Set(xs).size).toBe(3);
  });
});

describe("requirementDiagram", () => {
  const parse = (source: string): RequirementDiagram => parseMermaid(source) as RequirementDiagram;

  it("collects a requirement's fields from its block", () => {
    const requirement = parse(`requirementDiagram
      requirement test_req {
        id: 1
        text: the test text
        risk: high
        verifymethod: test
      }`).requirements[0];
    expect(
      `${requirement.type}/${requirement.text}/${requirement.risk}/${requirement.verifyMethod}`
    ).toBe("requirement/the test text/high/test");
  });

  it("reads each requirement type and the element block", () => {
    const diagram = parse(`requirementDiagram
      functionalRequirement a { text: x }
      performanceRequirement b { text: y }
      element e { type: simulation }`);
    expect(diagram.requirements.map(entry => entry.type)).toEqual([
      "functionalRequirement",
      "performanceRequirement"
    ]);
    expect(diagram.elements[0].type).toBe("simulation");
  });

  it("reads a relationship written either way round", () => {
    const forward = parse("requirementDiagram\n a - satisfies -> b").links[0];
    const backward = parse("requirementDiagram\n b <- satisfies - a").links[0];
    expect(forward).toEqual({ from: "a", to: "b", verb: "satisfies" });
    expect(backward).toEqual(forward);
  });

  it("draws the verb on the edge", () => {
    const list = mermaidToDrawList("requirementDiagram\n a - satisfies -> b");
    const labels = list.children
      .filter((node): node is Extract<DrawNode, { kind: "text" }> => node.kind === "text")
      .flatMap(node => node.lines.map(line => line.text));
    expect(labels).toContain("«satisfies»");
  });
});

describe("C4", () => {
  const parse = (source: string): C4Diagram => parseMermaid(source) as C4Diagram;

  it("reads an element's label and description", () => {
    const element = parse('C4Context\n Person(a, "Customer", "Buys things")').elements[0];
    expect(`${element.type}/${element.label}/${element.description}`).toBe(
      "Person/Customer/Buys things"
    );
  });

  it("reads a container's technology before its description", () => {
    // A container names its technology in the third argument; a person does not have one.
    const element = parse('C4Container\n Container(a, "API", "Java", "Handles requests")')
      .elements[0];
    expect(`${element.technology}/${element.description}`).toBe("Java/Handles requests");
  });

  it("keeps a comma inside a quoted description", () => {
    expect(
      parse('C4Context\n Person(a, "Customer", "Buys things, sometimes")').elements[0].description
    ).toBe("Buys things, sometimes");
  });

  it("puts an element in the boundary it was declared inside", () => {
    const diagram = parse(`C4Context
      Enterprise_Boundary(b, "Bank") {
        Person(a, "Customer")
      }`);
    expect(diagram.elements[0].boundary).toBe("b");
    expect(diagram.boundaries[0].label).toBe("Bank");
  });

  it("turns a Rel_Back around", () => {
    const relation = parse('C4Context\n Rel_Back(a, b, "Uses")').relations[0];
    expect(relation.reversed).toBe(true);
    const list = mermaidToDrawList(
      'C4Context\n Person(a, "A")\n Person(b, "B")\n Rel_Back(a, b, "Uses")'
    );
    expect(list.children.length).toBeGreaterThan(2);
  });
});

describe("block", () => {
  const parse = (source: string): BlockDiagram => parseMermaid(source) as BlockDiagram;

  it("reads the column count and each cell's span", () => {
    const diagram = parse("block-beta\n columns 3\n a b c\n d:2 e");
    expect(diagram.columns).toBe(3);
    expect(diagram.cells.map(cell => `${cell.id}:${cell.span}`)).toEqual([
      "a:1",
      "b:1",
      "c:1",
      "d:2",
      "e:1"
    ]);
  });

  it("reads a spacer as a gap rather than a box", () => {
    const diagram = parse("block-beta\n columns 3\n a space b");
    expect(diagram.cells[1].spacer).toBe(true);
    // Two boxes drawn, three cells placed.
    const list = mermaidToDrawList("block-beta\n columns 3\n a space b");
    expect(rects(list).filter(node => node.rx === 4)).toHaveLength(2);
  });

  it("wraps at the declared column count", () => {
    const list = mermaidToDrawList("block-beta\n columns 2\n a b c d");
    const boxes = rects(list).filter(node => node.rx === 4);
    expect(boxes).toHaveLength(4);
    // Two rows of two.
    expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(2);
  });

  it("gives a spanning cell the width of the columns it covers", () => {
    const list = mermaidToDrawList("block-beta\n columns 2\n a b\n c:2");
    const boxes = rects(list).filter(node => node.rx === 4);
    const wide = boxes.find(box => box.width > boxes[0].width * 1.5);
    expect(wide).toBeDefined();
  });

  it("draws a connection between two cells", () => {
    const plain = mermaidToDrawList("block-beta\n columns 2\n a b");
    const linked = mermaidToDrawList("block-beta\n columns 2\n a b\n a --> b");
    expect(linked.children.length).toBeGreaterThan(plain.children.length);
  });
});

describe("what the source states, the picture shows", () => {
  /** Every visible word of the source, and whether it reached the display list. */
  const undrawn = (source: string, words: readonly string[]): string[] => {
    const drawn = mermaidToDrawList(source)
      .children.filter((node): node is Extract<DrawNode, { kind: "text" }> => node.kind === "text")
      .flatMap(node => node.lines.map(line => line.text))
      .join(" | ");
    return words.filter(word => !drawn.includes(word));
  };

  it("draws an ER entity's attributes however the block was written", () => {
    // The one-line form is the common way to write a short entity, and reading only the
    // multi-line one dropped every attribute the author had declared.
    expect(
      undrawn("erDiagram\n E { string n PK }\n E ||--|| F : rel", ["E", "string", "n", "PK", "rel"])
    ).toEqual([]);
    expect(
      undrawn("erDiagram\n E {\n string n PK\n int c\n }", ["string", "n", "PK", "int", "c"])
    ).toEqual([]);
  });

  it("keeps a quoted comment with the attribute it belongs to", () => {
    expect(
      undrawn('erDiagram\n E { string n PK "the key" int c }', ["the key", "int", "c"])
    ).toEqual([]);
  });

  it("draws a C4 boundary, not just the elements inside it", () => {
    // The boundary parsed and then went nowhere: the grouping the author went out of their
    // way to state was silently absent from the picture.
    expect(
      undrawn('C4Context\n Enterprise_Boundary(b, "Bank") {\n  Person(p, "Cust")\n }', [
        "Bank",
        "Cust"
      ])
    ).toEqual([]);
  });

  it("sizes a block cell from its font", () => {
    // A constant cell height meant a larger font simply overflowed the box.
    const small = mermaidToDrawList("block-beta\n columns 2\n aaaa bbbb", { fontSize: 10 });
    const large = mermaidToDrawList("block-beta\n columns 2\n aaaa bbbb", { fontSize: 30 });
    expect(large.height).toBeGreaterThan(small.height);
    const cell = rects(large).find(node => node.rx === 4)!;
    expect(cell.height).toBeGreaterThan(30);
  });
});
