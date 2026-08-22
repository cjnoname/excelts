/**
 * The parser.
 *
 * Mermaid's surface syntax carries meaning in punctuation — `[]` against `{}` against
 * `(())`, `-->` against `-.->` against `==>` — so most of what can go wrong is a bracket
 * or a dash read as the wrong thing. These tests are written per construct for that
 * reason: when one fails it names the construct rather than reporting that a diagram
 * came out different.
 */
import { MermaidSyntaxError, parseMermaid } from "@mermaid/index";
import type { FlowchartDiagram, PieDiagram, SequenceDiagram } from "@mermaid/types";
import { describe, expect, it } from "vitest";

const flow = (source: string): FlowchartDiagram => parseMermaid(source) as FlowchartDiagram;

describe("a flowchart's header", () => {
  it("takes its direction from the header", () => {
    expect(flow("flowchart LR\n A --> B").direction).toBe("LR");
    expect(flow("graph RL\n A --> B").direction).toBe("RL");
  });

  it("reads TD as TB, which is the same direction spelled twice", () => {
    expect(flow("flowchart TD\n A --> B").direction).toBe("TB");
  });

  it("defaults to top-to-bottom", () => {
    expect(flow("flowchart\n A --> B").direction).toBe("TB");
  });

  it("does not read the header as a node", () => {
    // `flowchart TD` parsed as a node called `flowchart` before the header was skipped.
    expect(flow("flowchart TD\n A --> B").nodes.map(node => node.id)).toEqual(["A", "B"]);
  });
});

describe("node shapes", () => {
  const shapeOf = (source: string): string => flow(`flowchart LR\n ${source}`).nodes[0].shape;

  it("reads each bracket pair as its own outline", () => {
    expect(shapeOf("a[box]")).toBe("rect");
    expect(shapeOf("a(round)")).toBe("round");
    expect(shapeOf("a([stadium])")).toBe("stadium");
    expect(shapeOf("a[[subroutine]]")).toBe("subroutine");
    expect(shapeOf("a[(db)]")).toBe("cylinder");
    expect(shapeOf("a((circle))")).toBe("circle");
    expect(shapeOf("a{rhombus}")).toBe("rhombus");
    expect(shapeOf("a{{hexagon}}")).toBe("hexagon");
    expect(shapeOf("a>asymmetric]")).toBe("asymmetric");
  });

  it("tells the four slanted shapes apart by their closing bracket", () => {
    expect(shapeOf("a[/parallelogram/]")).toBe("parallelogram");
    expect(shapeOf("a[\\parallelogramAlt\\]")).toBe("parallelogramAlt");
    expect(shapeOf("a[/trapezoid\\]")).toBe("trapezoid");
    expect(shapeOf("a[\\trapezoidAlt/]")).toBe("trapezoidAlt");
  });

  it("closes a label at the nearest matching bracket, not the first one listed", () => {
    // `[/…/]` and `[/…\]` share an opener. Trying them in table order let the first node
    // run on to the *second* node's closing bracket and swallow the arrow between them.
    const diagram = flow("flowchart LR\n a[/one/] --> b[\\two\\]");
    expect(diagram.nodes.map(node => `${node.id}:${node.shape}:${node.text}`)).toEqual([
      "a:parallelogram:one",
      "b:parallelogramAlt:two"
    ]);
    expect(diagram.edges).toHaveLength(1);
  });

  it("prefers the longer opener when two close in the same place", () => {
    expect(shapeOf("a[[sub]]")).toBe("subroutine");
  });

  it("defaults a node that is only ever referenced to a box named after its id", () => {
    const node = flow("flowchart LR\n A --> B").nodes[1];
    expect([node.shape, node.text]).toEqual(["rect", "B"]);
  });
});

describe("links", () => {
  const edgeOf = (source: string) => flow(`flowchart LR\n ${source}`).edges[0];

  it("reads the three strokes", () => {
    expect(edgeOf("A --> B").stroke).toBe("solid");
    expect(edgeOf("A -.-> B").stroke).toBe("dotted");
    expect(edgeOf("A ==> B").stroke).toBe("thick");
  });

  it("reads each end decoration", () => {
    expect(edgeOf("A --> B").endEnd).toBe("arrow");
    expect(edgeOf("A --- B").endEnd).toBe("none");
    expect(edgeOf("A --o B").endEnd).toBe("circle");
    expect(edgeOf("A --x B").endEnd).toBe("cross");
  });

  it("reads a bidirectional link as decorated at both ends", () => {
    const edge = edgeOf("A <--> B");
    expect([edge.startEnd, edge.endEnd]).toEqual(["arrow", "arrow"]);
  });

  it("takes a label from either spelling", () => {
    expect(edgeOf("A -- inline --> B").label).toBe("inline");
    expect(edgeOf("A -->|piped| B").label).toBe("piped");
  });

  it("reads a longer link as a request for more rank separation", () => {
    // The extra dashes are how an author keeps two branches of unequal depth level.
    expect(edgeOf("A --> B").minRankSpan).toBe(1);
    expect(edgeOf("A ---> B").minRankSpan).toBe(2);
    expect(edgeOf("A ----> B").minRankSpan).toBe(3);
  });

  it("does not count the dashes a split label adds", () => {
    // `-- text -->` is the minimum length in its own form, not a longer link.
    expect(edgeOf("A -- text --> B").minRankSpan).toBe(1);
  });

  it("counts a dotted link's dots", () => {
    expect(edgeOf("A -.-> B").minRankSpan).toBe(1);
    expect(edgeOf("A -..-> B").minRankSpan).toBe(2);
  });
});

describe("chains and groups", () => {
  it("records every link in a chain", () => {
    expect(flow("flowchart LR\n A --> B --> C").edges.map(e => `${e.from}${e.to}`)).toEqual([
      "AB",
      "BC"
    ]);
  });

  it("expands `&` into one edge per pair", () => {
    expect(flow("flowchart LR\n A & B --> C & D").edges.map(e => `${e.from}${e.to}`)).toEqual([
      "AC",
      "AD",
      "BC",
      "BD"
    ]);
  });

  it("keeps a chain's shapes with the nodes they were written on", () => {
    const nodes = flow("flowchart LR\n A[one] --> B{two} --> C((three))").nodes;
    expect(nodes.map(n => `${n.shape}:${n.text}`)).toEqual([
      "rect:one",
      "rhombus:two",
      "circle:three"
    ]);
  });
});

describe("subgraphs and classes", () => {
  it("collects a subgraph's members and its title", () => {
    const diagram = flow(`flowchart TB
      subgraph one [Group One]
        A --> B
      end
      B --> C`);
    expect(diagram.subgraphs).toEqual([{ id: "one", text: "Group One", nodeIds: ["A", "B"] }]);
  });

  it("keeps a node in the group it was first seen in", () => {
    const diagram = flow(`flowchart TB
      subgraph g [G]
        A
      end
      A --> B`);
    expect(diagram.subgraphs[0].nodeIds).toEqual(["A"]);
  });

  it("reads a classDef and both ways of applying it", () => {
    const diagram = flow(`flowchart LR
      A:::hot --> B
      class B hot
      classDef hot fill:#f96,stroke:#333,stroke-width:2px`);
    expect(diagram.classDefs).toEqual([
      { name: "hot", fill: "#f96", stroke: "#333", strokeWidth: 2 }
    ]);
    expect(diagram.nodes.map(n => `${n.id}:${n.classes.join()}`)).toEqual(["A:hot", "B:hot"]);
  });

  it("does not read a styling statement as a node", () => {
    const diagram = flow(`flowchart LR
      A --> B
      style A fill:#f9f
      click A "https://example.com"`);
    expect(diagram.nodes.map(n => n.id)).toEqual(["A", "B"]);
  });
});

describe("lexical rules", () => {
  it("drops a comment but keeps a percent sign inside a label", () => {
    // A quoted label may contain the comment marker; only an unquoted `%%` starts one.
    const diagram = flow(`flowchart LR
      %% a comment
      A["50% done, 100%% sure"] --> B`);
    expect(diagram.nodes[0].text).toBe("50% done, 100%% sure");
    expect(diagram.nodes).toHaveLength(2);
  });

  it("ends a statement at a semicolon or a newline", () => {
    expect(flow("flowchart LR\n A --> B; B --> C").edges).toHaveLength(2);
  });

  it("keeps a semicolon that sits inside a label", () => {
    expect(flow('flowchart LR\n A["a; b"] --> B').nodes[0].text).toBe("a; b");
  });

  it("reads `<br>` as a line break and resolves an entity", () => {
    expect(flow("flowchart LR\n A[one<br/>two] --> B").nodes[0].text).toBe("one\ntwo");
    expect(flow("flowchart LR\n A[a #35; b] --> B").nodes[0].text).toBe("a # b");
  });

  it("skips an init directive rather than reading it as statements", () => {
    const diagram = flow(`%%{init: {"theme": "dark"}}%%
      flowchart LR
      A --> B`);
    expect(diagram.nodes.map(n => n.id)).toEqual(["A", "B"]);
  });
});

describe("pie", () => {
  const pie = (source: string): PieDiagram => parseMermaid(source) as PieDiagram;

  it("reads slices, the title and showData from the header", () => {
    const diagram = pie(`pie showData title Split
      "A" : 60
      "B" : 40`);
    expect(diagram.title).toBe("Split");
    expect(diagram.showData).toBe(true);
    expect(diagram.slices).toEqual([
      { label: "A", value: 60 },
      { label: "B", value: 40 }
    ]);
  });

  it("takes a title from its own statement and tolerates unquoted labels", () => {
    const diagram = pie("pie\n title Shares\n Alpha : 1.5");
    expect([diagram.title, diagram.showData, diagram.slices[0].label]).toEqual([
      "Shares",
      false,
      "Alpha"
    ]);
  });
});

describe("sequenceDiagram", () => {
  const sequence = (source: string): SequenceDiagram => parseMermaid(source) as SequenceDiagram;

  it("reads participants, aliases and message arrows", () => {
    const diagram = sequence(`sequenceDiagram
      participant U as User
      participant A as API
      U->>A: request
      A-->>U: reply`);
    expect(diagram.participants.map(p => `${p.id}:${p.text}`)).toEqual(["U:User", "A:API"]);
    expect(diagram.messages.map(m => `${m.from}${m.to}:${m.line}:${m.arrow}:${m.text}`)).toEqual([
      "UA:solid:arrow:request",
      "AU:dotted:arrow:reply"
    ]);
  });

  it("declares a participant that only appears in a message", () => {
    expect(sequence("sequenceDiagram\n A->>B: hi").participants.map(p => p.id)).toEqual(["A", "B"]);
  });

  it("reads the cross and open-circle heads", () => {
    const diagram = sequence("sequenceDiagram\n A-xB: lost\n A-)B: async");
    expect(diagram.messages.map(m => m.arrow)).toEqual(["cross", "circle"]);
  });

  it("does not read a block keyword as a message", () => {
    const diagram = sequence(`sequenceDiagram
      A->>B: one
      loop every minute
        B->>A: two
      end
      Note over A,B: a note`);
    expect(diagram.messages.map(m => m.text)).toEqual(["one", "two"]);
  });
});

describe("an unsupported diagram", () => {
  it("names what it could not draw rather than drawing nothing", () => {
    // An empty picture and a picture of nothing look the same to the author.
    expect(() => parseMermaid("zenuml\n title A")).toThrow(MermaidSyntaxError);
    expect(() => parseMermaid("zenuml\n title A")).toThrow(/zenuml/);
  });

  it("reports an empty source as empty", () => {
    expect(() => parseMermaid("   \n\n")).toThrow(/empty/);
  });
});
