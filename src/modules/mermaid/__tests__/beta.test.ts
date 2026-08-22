/**
 * The layout improvements and the four remaining diagram types.
 *
 * The layout tests measure what the change was *for* — crossings, and whether a long edge
 * goes through the diagram or around it — rather than pinning coordinates, which would
 * have to be rewritten whenever a margin moved and would say nothing about quality.
 */
import type { DrawNode } from "@draw/types";
import { layoutFlowchart, mermaidToDrawList, parseMermaid } from "@mermaid/index";
import { resolveTheme } from "@mermaid/theme";
import type {
  ArchitectureDiagram,
  FlowchartDiagram,
  KanbanDiagram,
  PacketDiagram,
  RadarDiagram
} from "@mermaid/types";
import { describe, expect, it } from "vitest";

/** Whether two segments properly cross. */
function segmentsCross(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
): boolean {
  const side = (
    p: { x: number; y: number },
    q: { x: number; y: number },
    r: { x: number; y: number }
  ): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(b1, b2, a1);
  const d2 = side(b1, b2, a2);
  const d3 = side(a1, a2, b1);
  const d4 = side(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** How many pairs of edges cross in the drawn result. */
function crossingCount(source: string): number {
  const result = layoutFlowchart(parseMermaid(source) as FlowchartDiagram);
  let total = 0;
  for (let i = 0; i < result.edges.length; i++) {
    for (let j = i + 1; j < result.edges.length; j++) {
      const a = result.edges[i].points;
      const b = result.edges[j].points;
      let hit = false;
      for (let x = 1; x < a.length && !hit; x++) {
        for (let y = 1; y < b.length && !hit; y++) {
          hit = segmentsCross(a[x - 1], a[x], b[y - 1], b[y]);
        }
      }
      if (hit) {
        total++;
      }
    }
  }
  return total;
}

/**
 * A layered graph with a repeatable shape, so a population of them can be measured.
 *
 * The generator is deliberately crude and deterministic: what matters is that the same
 * twenty-five graphs are drawn each run, not that they are realistic.
 */
function randomLayered(seed: number): string {
  let state = seed;
  const random = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const lines: string[] = [];
  let previous: string[] = [];
  for (const [rank, size] of [4, 5, 4, 5].entries()) {
    const current = Array.from({ length: size }, (_, i) => `r${rank}n${i}`);
    for (const node of current) {
      for (const parent of previous) {
        if (random() < 0.35) {
          lines.push(` ${parent} --> ${node}`);
        }
      }
    }
    previous = current;
  }
  return `flowchart TD\n${lines.join("\n")}`;
}

describe("layered layout", () => {
  it("keeps a dense graph free of crossings", () => {
    expect(crossingCount("flowchart TD\n A1 --> B2\n A2 --> B1\n A3 --> B3")).toBe(0);
    expect(
      crossingCount(
        "flowchart TD\n A-->D\n A-->E\n B-->D\n B-->F\n C-->E\n C-->F\n D-->G\n E-->G\n F-->G"
      )
    ).toBe(0);
  });

  it("beats the median alone across a spread of graphs", () => {
    // The median places a node at the average of where its neighbours sit; it cannot tell
    // that two *particular* neighbours are the wrong way round, and swapping adjacent
    // pairs is what finds those. No single small graph demonstrates it — the median gets
    // most of them right on its own — so the claim is measured over a population, which is
    // also the honest way to state a heuristic's value.
    let total = 0;
    for (let seed = 1; seed <= 25; seed++) {
      total += crossingCount(randomLayered(seed));
    }
    // 31 without the transpose pass, 28 with it. The bound is between the two.
    expect(total).toBeLessThan(30);
  }, 60_000);

  it("threads a skip edge through the diagram rather than around it", () => {
    // Dummy nodes hold a lane open at each rank the edge passes through, so it can be
    // ordered against what is there instead of routed around everything afterwards.
    const result = layoutFlowchart(
      parseMermaid("flowchart TD\n A --> B --> C --> D\n A --> D") as FlowchartDiagram
    );
    const skip = result.edges.find(route => route.edge.from === "A" && route.edge.to === "D")!;
    for (const point of skip.points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(result.width);
    }
  });

  it("does not let the scaffolding bend the trunk", () => {
    // A dummy threading past a chain used to pull its neighbours sideways, so the trunk
    // drifted towards whichever long edge happened to run alongside it.
    const result = layoutFlowchart(
      parseMermaid("flowchart TD\n A --> B --> C --> D --> E\n A --> E") as FlowchartDiagram
    );
    const centres = ["A", "B", "C", "D", "E"].map(id => {
      const box = result.nodes.find(node => node.id === id)!;
      return box.x + box.width / 2;
    });
    // Within half a port spacing (26 units), which is what separating the skip edge from
    // the trunk costs and is not a bend. Letting a dummy pull on its neighbours put the
    // trunk tens of units off instead, which is.
    for (const centre of centres) {
      expect(Math.abs(centre - centres[0])).toBeLessThan(14);
    }
  });

  it("leaves no dummy in the result", () => {
    // They are scaffolding: they steer the layout and then leave.
    const result = layoutFlowchart(
      parseMermaid("flowchart TD\n A --> B --> C --> D\n A --> D") as FlowchartDiagram
    );
    expect(result.nodes.map(node => node.id).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("reads a link written without spaces", () => {
    // `-` may sit inside an identifier, so `n1-->n2` parsed as one node called `n1--` and
    // the arrow disappeared with the edge it declared.
    const diagram = parseMermaid("flowchart TD\n n1-->n2-->n3") as FlowchartDiagram;
    expect(diagram.edges.map(edge => `${edge.from}${edge.to}`)).toEqual(["n1n2", "n2n3"]);
    expect(
      (parseMermaid("flowchart TD\n my-node-->other-node") as FlowchartDiagram).edges[0]
    ).toMatchObject({ from: "my-node", to: "other-node" });
  });
});

describe("theme", () => {
  it("picks a legible ink for whatever colour the text sits on", () => {
    // Mermaid's own first palette entry is a pale lilac; white on it is unreadable.
    const theme = resolveTheme();
    const onPale = theme.paletteText({ r: 0.93, g: 0.93, b: 1, a: 1 });
    const onDark = theme.paletteText({ r: 0.1, g: 0.2, b: 0.6, a: 1 });
    expect(onPale.r).toBeLessThan(0.5);
    expect(onDark.r).toBeGreaterThan(0.5);
  });

  it("judges by luminance, not by the raw channels", () => {
    // Pure blue is dark despite a full channel; a naive test would call it light.
    const theme = resolveTheme();
    expect(theme.paletteText({ r: 0, g: 0, b: 1, a: 1 }).r).toBeGreaterThan(0.5);
  });
});

describe("packet", () => {
  const parse = (source: string): PacketDiagram => parseMermaid(source) as PacketDiagram;

  it("reads a range and a single bit alike", () => {
    const diagram = parse('packet-beta\n 0-15: "A"\n 16: "B"');
    expect(diagram.fields.map(field => `${field.start}-${field.end}:${field.label}`)).toEqual([
      "0-15:A",
      "16-16:B"
    ]);
  });

  it("splits a field that straddles a row", () => {
    // One field, two cells: the diagram is read row by row.
    const list = mermaidToDrawList('packet-beta\n bits-per-row: 8\n 4-11: "Wide"');
    const cells = list.children.filter(node => node.kind === "rect");
    expect(cells).toHaveLength(2);
  });

  it("sizes a cell by the bits it covers", () => {
    const list = mermaidToDrawList('packet-beta\n 0-3: "Narrow"\n 4-19: "Wide"');
    const cells = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect"
    );
    expect(cells[1].width).toBeCloseTo(cells[0].width * 4, 0);
  });
});

describe("kanban", () => {
  const parse = (source: string): KanbanDiagram => parseMermaid(source) as KanbanDiagram;

  it("takes its columns and cards from the indentation", () => {
    const diagram = parse("kanban\n todo[To do]\n  a[One]\n  b[Two]\n done[Done]\n  c[Three]");
    expect(diagram.columns.map(column => `${column.title}:${column.cards.length}`)).toEqual([
      "To do:2",
      "Done:1"
    ]);
  });

  it("reads a card's metadata block", () => {
    const card = parse('kanban\n todo[T]\n  a[Task]@{ assigned: "Ada", priority: "High" }')
      .columns[0].cards[0];
    expect(`${card.text}/${card.assigned}/${card.priority}`).toBe("Task/Ada/High");
  });

  it("draws a lane per column and a panel per card", () => {
    const list = mermaidToDrawList("kanban\n a[A]\n  x[One]\n b[B]");
    const panels = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect" && node.rx === 4
    );
    expect(panels).toHaveLength(1);
  });
});

describe("radar", () => {
  const parse = (source: string): RadarDiagram => parseMermaid(source) as RadarDiagram;

  it("reads axes and curves", () => {
    const diagram = parse('radar-beta\n axis a["A"], b["B"], c["C"]\n curve x["X"]{1, 2, 3}');
    expect(diagram.axes).toEqual(["A", "B", "C"]);
    expect(diagram.series[0]).toEqual({ label: "X", values: [1, 2, 3] });
  });

  it("draws a closed ring per series", () => {
    const list = mermaidToDrawList(
      "radar-beta\n axis a, b, c, d\n curve one{1,2,3,4}\n curve two{4,3,2,1}"
    );
    const rings = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "polyline" }> =>
        node.kind === "polyline" && node.closed === true && node.points.length === 4
    );
    // Four grid rings plus two series.
    expect(rings.length).toBeGreaterThanOrEqual(6);
  });

  it("refuses to draw fewer than three axes rather than inventing a shape", () => {
    expect(mermaidToDrawList("radar-beta\n axis a, b\n curve x{1,2}").children).toHaveLength(0);
  });
});

describe("architecture", () => {
  const parse = (source: string): ArchitectureDiagram =>
    parseMermaid(source) as ArchitectureDiagram;

  it("reads services, their icons and the group they sit in", () => {
    const diagram = parse(`architecture-beta
      group api(cloud)[API]
      service db(database)[Database] in api
      db --> server`);
    expect(
      diagram.nodes.map(
        node => `${node.id}/${node.icon ?? "-"}/${node.group ?? "-"}/${node.isGroup}`
      )
    ).toEqual(["api/cloud/-/true", "db/database/api/false"]);
  });

  it("reads the side an edge leaves from", () => {
    const edge = parse("architecture-beta\n service a\n service b\n a:R --> L:b").edges[0];
    expect(`${edge.fromSide}/${edge.toSide}/${edge.arrow}`).toBe("R/L/true");
  });

  it("names the icon it cannot draw rather than dropping it", () => {
    const list = mermaidToDrawList(
      "architecture-beta\n service db(database)[Store]\n service a\n db --> a"
    );
    const labels = list.children
      .filter((node): node is Extract<DrawNode, { kind: "text" }> => node.kind === "text")
      .flatMap(node => node.lines.map(line => line.text));
    expect(labels).toContain("Store");
    expect(labels).toContain("(database)");
  });
});

describe("every token does what its name says", () => {
  it("colours data from the palette and boxes from the node tokens", () => {
    // A Gantt bar is a value, not a box: restyling a flowchart's boxes must not restyle a
    // chart, and vice versa.
    const bar = mermaidToDrawList("gantt\n section S\n T :2024-01-01, 5d", {
      theme: { palette: ["#ff0000"] }
    });
    const unchanged = mermaidToDrawList("gantt\n section S\n T :2024-01-01, 5d", {
      theme: { nodeFill: "#ff0000" }
    });
    const plain = mermaidToDrawList("gantt\n section S\n T :2024-01-01, 5d");
    expect(JSON.stringify(bar)).not.toBe(JSON.stringify(plain));
    expect(JSON.stringify(unchanged)).toBe(JSON.stringify(plain));
  });

  it("colours a flowchart's boxes from the node tokens and not from the palette", () => {
    const source = "flowchart TD\n A --> B";
    const plain = JSON.stringify(mermaidToDrawList(source));
    expect(JSON.stringify(mermaidToDrawList(source, { theme: { nodeFill: "#ff0000" } }))).not.toBe(
      plain
    );
    expect(JSON.stringify(mermaidToDrawList(source, { theme: { palette: ["#ff0000"] } }))).toBe(
      plain
    );
  });
});
