/**
 * Statements whose meaning the picture used to lose.
 *
 * Every case here is something an author wrote that the diagram then contradicted or
 * omitted — a direction ignored, a nested frame drawn empty, a negative value drawn as a
 * positive one. Those are worse than an ugly diagram: a reader has no way to tell they are
 * being misinformed, so each is pinned rather than left to a visual check.
 */
import type { DrawNode } from "@draw/types";
import { layoutFlowchart, mermaidToDrawList, parseMermaid } from "@mermaid/index";
import {
  addWorkingTime,
  parseCalendarDuration,
  parseDuration,
  parseWithFormat
} from "@mermaid/parse/dates";
import type {
  BlockDiagram,
  C4Diagram,
  FlowchartDiagram,
  GanttDiagram,
  MindmapDiagram,
  RequirementDiagram,
  SankeyDiagram,
  SequenceDiagram,
  StateDiagram
} from "@mermaid/types";
import { describe, expect, it } from "vitest";

const centre = (source: string, id: string): { x: number; y: number } => {
  const result = layoutFlowchart(parseMermaid(source) as FlowchartDiagram);
  const box = result.nodes.find(node => node.id === id)!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const rects = (source: string): Array<Extract<DrawNode, { kind: "rect" }>> =>
  mermaidToDrawList(source).children.filter(
    (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect"
  );
const texts = (source: string): string[] =>
  mermaidToDrawList(source)
    .children.filter((node): node is Extract<DrawNode, { kind: "text" }> => node.kind === "text")
    .flatMap(node => node.lines.map(line => line.text));

describe("a declared direction is the direction drawn", () => {
  it("grows upwards for BT and leftwards for RL", () => {
    // Ranking happens in the canonical direction and the finished picture is mirrored;
    // reversing the ranks instead would have to be undone in every pass that reads them.
    expect(centre("flowchart BT\n A --> B", "A").y).toBeGreaterThan(
      centre("flowchart BT\n A --> B", "B").y
    );
    expect(centre("flowchart RL\n A --> B", "A").x).toBeGreaterThan(
      centre("flowchart RL\n A --> B", "B").x
    );
  });

  it("still grows downwards for TB and rightwards for LR", () => {
    expect(centre("flowchart TB\n A --> B", "A").y).toBeLessThan(
      centre("flowchart TB\n A --> B", "B").y
    );
    expect(centre("flowchart LR\n A --> B", "A").x).toBeLessThan(
      centre("flowchart LR\n A --> B", "B").x
    );
  });
});

describe("a nested group contains what was nested inside it", () => {
  const nested = `flowchart TB
    subgraph outer [Outer]
      subgraph inner [Inner]
        A --> B
      end
    end`;

  it("records a node against every group it sits in", () => {
    // Recording only the innermost left the outer frame with no members, and a frame with no
    // members is not drawn at all — the group simply vanished.
    const diagram = parseMermaid(nested) as FlowchartDiagram;
    expect(diagram.subgraphs.map(group => `${group.id}:${group.nodeIds.join()}`).sort()).toEqual([
      "inner:A,B",
      "outer:A,B"
    ]);
  });

  it("draws the outer frame around the inner one", () => {
    // Two groups holding the same nodes are indistinguishable by membership, so the frames
    // came out the same size and the containment was invisible. The declared parent tells
    // them apart.
    const result = layoutFlowchart(parseMermaid(nested) as FlowchartDiagram);
    const outer = result.groups.find(group => group.id === "outer")!;
    const inner = result.groups.find(group => group.id === "inner")!;
    expect(outer.x).toBeLessThan(inner.x);
    expect(outer.width).toBeGreaterThan(inner.width);
    expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  });

  it("does the same for a nested composite state", () => {
    const diagram = parseMermaid(
      "stateDiagram-v2\n state Outer {\n state Inner {\n A --> B\n }\n }"
    ) as StateDiagram;
    const outer = diagram.composites.find(group => group.id === "Outer")!;
    expect(outer.nodeIds).toContain("A");
    expect(outer.nodeIds).toContain("B");
  });
});

describe("YAML frontmatter", () => {
  it("is skipped rather than read as the diagram type", () => {
    // Mermaid's own documentation puts the title in frontmatter, so the recommended spelling
    // was rejected outright — for every one of the supported types.
    for (const [source, kind] of [
      ["---\ntitle: T\n---\nflowchart LR\n A-->B", "flowchart"],
      ['---\ntitle: T\n---\npie\n "A" : 60', "pie"],
      ["---\ntitle: T\n---\nmindmap\n root\n  A", "mindmap"],
      ["---\ntitle: T\n---\nsankey-beta\nA,B,10", "sankey"]
    ] as Array<[string, string]>) {
      expect(parseMermaid(source).kind).toBe(kind);
    }
  });
});

describe("sequence activation", () => {
  it("reads `+` and `-` as part of the arrow, not of the name", () => {
    // Read as a name they produced participants called `+B` and `-A`, so an ordinary exchange
    // came out as four participants who never spoke to each other.
    const diagram = parseMermaid(
      "sequenceDiagram\n A->>+B: req\n B-->>-A: reply"
    ) as SequenceDiagram;
    expect(diagram.participants.map(entry => entry.id)).toEqual(["A", "B"]);
    expect(diagram.messages[0].activates).toBe(true);
    expect(diagram.messages[1].deactivates).toBe(true);
  });

  it("draws a bar for the span it was activated over", () => {
    const plain = rects("sequenceDiagram\n A->>B: req\n B-->>A: reply").length;
    const activated = rects("sequenceDiagram\n A->>+B: req\n B-->>-A: reply").length;
    expect(activated).toBe(plain + 1);
  });

  it("gives a wrapped message the height its label needs", () => {
    // A fixed row height let a long label grow upwards over whatever was above it.
    const short = mermaidToDrawList("sequenceDiagram\n A->>B: hi\n A->>B: next");
    const long = mermaidToDrawList(
      "sequenceDiagram\n A->>B: a message long enough that it has to be wrapped onto several lines\n A->>B: next"
    );
    expect(long.height).toBeGreaterThan(short.height);
  });

  it("draws an actor as a figure rather than a box", () => {
    const withActor = mermaidToDrawList("sequenceDiagram\n actor U\n participant P\n U->>P: x");
    const withParticipant = mermaidToDrawList(
      "sequenceDiagram\n participant U\n participant P\n U->>P: x"
    );
    // Two head circles, one per repeated header.
    const circles = (list: typeof withActor): number =>
      list.children.filter(node => node.kind === "ellipse").length;
    expect(circles(withActor)).toBeGreaterThan(circles(withParticipant));
  });
});

describe("Gantt calendar arithmetic", () => {
  const tasks = (body: string): GanttDiagram["tasks"] =>
    (parseMermaid(`gantt\n${body}`) as GanttDiagram).tasks;
  const day = (time: number): string => new Date(time).toISOString().slice(0, 10);

  it("reads a date in the format the source declared", () => {
    // Reading only ISO turned `01-02-2024` into the task's identifier, after which a task
    // with no other start had nothing to stand on and was dropped entirely.
    const [task] = tasks(" dateFormat DD-MM-YYYY\n section S\n T :01-02-2024, 2d");
    expect(day(task.start)).toBe("2024-02-01");
  });

  it("reads a calendar duration as months rather than as a length", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1M")).toBeUndefined();
    expect(parseCalendarDuration("1M")).toEqual({ months: 1 });
    expect(parseCalendarDuration("1y")).toEqual({ months: 12 });
  });

  it("tells a month from a minute", () => {
    // `m` and `M` differ only in case. What actually keeps them apart is that `M` is not a
    // fixed-length unit at all — it is read by `parseCalendarDuration` and added to the start
    // date — so this pins the two answers rather than the pattern that produces them.
    const [minute] = tasks(" section S\n T :2024-01-01, 30m");
    const [month] = tasks(" section S\n T :2024-01-01, 1M");
    expect(day(minute.end)).toBe("2024-01-01");
    expect(day(month.end)).toBe("2024-02-01");
    expect(month.end - month.start).toBeGreaterThan(minute.end - minute.start);
  });

  it("advances a month by the calendar, not by thirty days", () => {
    const [task] = tasks(" section S\n T :2024-01-31, 1M");
    expect(day(task.end)).toBe("2024-02-29");
  });

  it("lengthens a task over the days the plan excludes", () => {
    // A plan that excludes weekends is making a claim about working time, so two days from a
    // Friday ends on the Tuesday.
    const [task] = tasks(" excludes weekends\n section S\n T :2024-01-05, 2d");
    expect(day(task.end)).toBe("2024-01-09");
    expect(day(addWorkingTime(Date.UTC(2024, 0, 5), 2 * 86_400_000, new Set([0, 6])))).toBe(
      "2024-01-09"
    );
  });

  it("puts a milestone at the middle of the span it was given", () => {
    const [task] = tasks(" section S\n M :milestone, 2024-01-01, 4d");
    expect(day(task.start)).toBe("2024-01-03");
  });

  it("parses a format it cannot express as nothing rather than as a wrong date", () => {
    expect(parseWithFormat("01-02-2024", "DD-MM-YYYY")).toBe(Date.UTC(2024, 1, 1));
    expect(parseWithFormat("nonsense", "DD-MM-YYYY")).toBeUndefined();
  });
});

describe("XY charts", () => {
  it("grows bars from zero, not from the bottom of the range", () => {
    // Anchoring at the range's floor drew -5 as a tall bar rising from -10, so a negative
    // reading looked like a large positive one.
    const bars = rects("xychart-beta\n y-axis -10 --> 10\n bar [-5, 5]").filter(
      node => node.rx === 2
    );
    expect(bars).toHaveLength(2);
    expect(Math.round(bars[0].height)).toBe(Math.round(bars[1].height));
    expect(bars[0].y).toBeGreaterThan(bars[1].y);
  });

  it("honours `horizontal`", () => {
    const vertical = mermaidToDrawList("xychart-beta\n x-axis [a, b]\n bar [10, 20]");
    const horizontal = mermaidToDrawList("xychart-beta horizontal\n x-axis [a, b]\n bar [10, 20]");
    expect(horizontal.width).toBe(vertical.height);
    expect(horizontal.height).toBe(vertical.width);
    // Bars now run along x, so the longer value is the wider bar.
    const bars = rects("xychart-beta horizontal\n x-axis [a, b]\n bar [10, 20]").filter(
      node => node.rx === 2
    );
    expect(bars[1].width).toBeGreaterThan(bars[0].width);
  });
});

describe("Sankey", () => {
  it("gives a cycle as many columns as it has nodes, not as many as it has passes", () => {
    // Relaxing every link pushed the depths up on each pass until they stopped, at a number
    // far past the column count the canvas was sized from — so the nodes went outside it.
    // Two nodes in a cycle occupy two columns; comparing against the canvas is not enough,
    // because a runaway depth widens the canvas too.
    const cycle = mermaidToDrawList("sankey-beta\n A,B,10\n B,A,10");
    const chain = mermaidToDrawList("sankey-beta\n A,B,10");
    const columns = (list: typeof cycle): number =>
      new Set(
        list.children
          .filter((node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect")
          .map(node => Math.round(node.x))
      ).size;
    expect(columns(cycle)).toBe(columns(chain));
    expect(cycle.width).toBeCloseTo(chain.width, 0);
  });

  it("fits a tall column inside the plot", () => {
    // The scale reserved room for four gaps whatever the column held.
    const list = mermaidToDrawList(
      `sankey-beta\n${Array.from({ length: 8 }, (_, i) => `A${i},Z,1`).join("\n")}`
    );
    for (const node of list.children) {
      if (node.kind === "rect") {
        expect(node.y + node.height).toBeLessThanOrEqual(list.height);
      }
    }
  });
});

describe("block cells", () => {
  it("keeps a label containing spaces in one cell", () => {
    // Split on whitespace, `A["Long label"]` became two unrelated boxes and the label was
    // lost with them.
    const diagram = parseMermaid('block-beta\n columns 1\n A["Long label"]') as BlockDiagram;
    expect(diagram.cells).toHaveLength(1);
    expect(diagram.cells[0].label).toBe("Long label");
  });

  it("still reads several cells on one row", () => {
    const diagram = parseMermaid('block-beta\n columns 3\n a["One two"] b c') as BlockDiagram;
    expect(diagram.cells.map(cell => cell.id)).toEqual(["a", "b", "c"]);
  });
});

describe("marks that carry the meaning", () => {
  it("keeps two relationships between the same classes apart", () => {
    // Keyed on `from\\0to`, the second overwrote the first, so an inheritance could be drawn
    // with a composition's diamond — and the two marks are the whole difference.
    const list = mermaidToDrawList("classDiagram\n B --|> A\n B *-- A");
    const closed = (points: number): number =>
      list.children.filter(
        node => node.kind === "polyline" && node.closed === true && node.points.length === points
      ).length;
    expect(closed(3)).toBe(1);
    expect(closed(4)).toBe(1);
  });

  it("draws two bars for an ER `exactly one`", () => {
    // One bar alone reads as "one or more".
    const exact = mermaidToDrawList("erDiagram\n A ||--|| B : owns");
    const many = mermaidToDrawList("erDiagram\n A ||--o{ B : owns");
    const strokes = (list: typeof exact): number =>
      list.children.filter(node => node.kind === "polyline" && node.points.length === 2).length;
    expect(strokes(exact)).toBeGreaterThan(2);
    expect(strokes(many)).toBeGreaterThan(strokes(exact) - 2);
  });

  it("shows an architecture service that only an edge named", () => {
    expect(texts("architecture-beta\n service db(database)[Database]\n db --> server")).toContain(
      "server"
    );
  });

  it("shows a commit's own id", () => {
    expect(texts('gitGraph\n commit id: "release-fix"')).toContain("release-fix");
  });

  it("starts a branch lane where the branch starts", () => {
    // Running every lane the full width made a branch look as though it had existed since the
    // first commit.
    const list = mermaidToDrawList("gitGraph\n commit\n commit\n branch dev\n commit");
    const lanes = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "polyline" }> =>
        node.kind === "polyline" && node.points.length === 2 && node.paint.stroke !== undefined
    );
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(lanes[1].points[0].x).toBeGreaterThan(lanes[0].points[0].x);
  });

  it("scales a radar to the max the source set, clamping anything past it", () => {
    // Letting the data raise the ceiling silently rescaled every other reading: the axis then
    // no longer meant what the source said it meant. The test compares the over-range series
    // against a value *at* the maximum — they must reach the same ring, which is what
    // "clamped" means and what a rescale would not produce.
    const clamped = mermaidToDrawList("radar-beta\n axis A, B, C\n max 5\n curve X{20, 5, 5}");
    const atMax = mermaidToDrawList("radar-beta\n axis A, B, C\n max 5\n curve X{5, 5, 5}");
    const reach = (list: typeof clamped): number => {
      const cx = list.width / 2;
      const cy = list.height / 2;
      const rings = list.children.filter(
        (node): node is Extract<DrawNode, { kind: "polyline" }> =>
          node.kind === "polyline" && node.closed === true
      );
      return Math.round(
        Math.max(
          ...rings.flatMap(ring => ring.points.map(point => Math.hypot(point.x - cx, point.y - cy)))
        )
      );
    };
    expect(reach(clamped)).toBe(reach(atMax));
  });
});

describe("a frame encloses its members and nobody else", () => {
  /** Ids whose box overlaps a group's frame. */
  const enclosed = (source: string, groupId: string): string[] => {
    const result = layoutFlowchart(parseMermaid(source) as FlowchartDiagram);
    const frame = result.groups.find(group => group.id === groupId)!;
    return result.nodes
      .filter(
        node =>
          node.x + node.width > frame.x &&
          node.x < frame.x + frame.width &&
          node.y + node.height > frame.y &&
          node.y < frame.y + frame.height
      )
      .map(node => node.id)
      .sort();
  };

  it("keeps a stranger out of a group that has another nested inside it", () => {
    // The eviction pass and the drawing pass had a padding each — the second larger, to leave
    // room for the nested frame — so the frame that was drawn was wider than the area that had
    // been cleared, and could still enclose a node that was never a member.
    expect(
      enclosed(
        `flowchart TB
          subgraph outer [Outer]
            subgraph inner [Inner]
              A --> B
            end
            C
          end
          X[Outsider] --> B`,
        "outer"
      )
    ).toEqual(["A", "B", "C"]);
  });

  it("still keeps a stranger out of a flat group", () => {
    expect(enclosed("flowchart TB\n subgraph g [G]\n  A --> B\n end\n X --> B", "g")).toEqual([
      "A",
      "B"
    ]);
  });
});

describe("C4 arguments are positional", () => {
  it("keeps an empty argument in its slot", () => {
    // Dropping empties shifted everything after one down a place, so the description was read
    // as the technology and the description itself was lost.
    const diagram = parseMermaid(
      'C4Container\n Container(a, "API", "", "Handles requests")'
    ) as C4Diagram;
    expect(diagram.elements[0].technology).toBe("");
    expect(diagram.elements[0].description).toBe("Handles requests");
  });

  it("still reads the forms that give no technology", () => {
    // A trailing run of empties carries nothing, so `Person(a, "Customer")` is two arguments.
    const bare = parseMermaid('C4Context\n Person(a, "Customer")') as C4Diagram;
    expect([bare.elements[0].label, bare.elements[0].description]).toEqual(["Customer", undefined]);
    const described = parseMermaid('C4Context\n Person(a, "Customer", "Buys things")') as C4Diagram;
    expect(described.elements[0].description).toBe("Buys things");
  });
});

describe("an inline requirement field", () => {
  it("keeps a quoted value that contains a colon", () => {
    // Reading only the unquoted form truncated at the first colon, so the field matched nothing
    // and vanished from the diagram.
    const diagram = parseMermaid(
      'requirementDiagram\n requirement r { text: "a: b" risk: high }'
    ) as RequirementDiagram;
    expect(diagram.requirements[0].text).toBe("a: b");
    expect(diagram.requirements[0].risk).toBe("high");
  });

  it("still reads an unquoted value", () => {
    const diagram = parseMermaid(
      "requirementDiagram\n requirement r { text: plain risk: low }"
    ) as RequirementDiagram;
    expect(diagram.requirements[0].text).toBe("plain");
    expect(diagram.requirements[0].risk).toBe("low");
  });
});

describe("comments follow one rule for every grammar", () => {
  it("keeps a quoted percent sign in the grammars whose syntax is whitespace", () => {
    // These three each had their own `replace(/%%.*$/, "")`, which is not quote-aware. The
    // shared rule is; an *unquoted* `%%` is a comment here exactly as it is in a flowchart.
    const quoted = parseMermaid('mindmap\n root\n  ["100%% coverage"]') as MindmapDiagram;
    expect(quoted.root?.children.map(child => child.text)).toEqual(["100%% coverage"]);
    const commented = parseMermaid("mindmap\n root\n  Child %% a note") as MindmapDiagram;
    expect(commented.root?.children.map(child => child.text)).toEqual(["Child"]);
  });

  it("drops a trailing comment from a Sankey row", () => {
    const diagram = parseMermaid("sankey-beta\nA,B,10 %% note") as SankeyDiagram;
    expect(diagram.links).toEqual([{ from: "A", to: "B", value: 10 }]);
  });
});
