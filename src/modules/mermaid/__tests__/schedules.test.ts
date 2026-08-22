/**
 * The diagram types whose layout is not a graph.
 *
 * A Gantt bar's position comes from the calendar, a journey's dot from a score, a mind
 * map's node from its subtree — none of them from ranking and ordering. What they have in
 * common is that the arithmetic *is* the diagram: a bar in the wrong place is not an ugly
 * chart, it is a wrong one. These tests are therefore mostly about the numbers.
 */
import type { DrawNode } from "@draw/types";
import { mermaidToDrawList, parseMermaid } from "@mermaid/index";
import { axisTicks, formatAxisDate, parseDate, parseDuration } from "@mermaid/parse/dates";
import type {
  GanttDiagram,
  GitGraphDiagram,
  JourneyDiagram,
  MindmapDiagram,
  TimelineDiagram
} from "@mermaid/types";
import { describe, expect, it } from "vitest";

const DAY = 86_400_000;

describe("dates", () => {
  it("reads a date in UTC, not in whatever zone the machine is in", () => {
    // `new Date("2024-01-01")` is the evening of the 31st west of Greenwich, which moves
    // every bar in the chart by a day.
    expect(parseDate("2024-01-01")).toBe(Date.UTC(2024, 0, 1));
    expect(formatAxisDate(Date.UTC(2024, 0, 1), DAY * 10)).toBe("1/1");
  });

  it("returns undefined for something that is not a date", () => {
    // Distinguishable from a date in 1970, which `NaN` or `0` would not be.
    expect(parseDate("30d")).toBeUndefined();
    expect(parseDate("")).toBeUndefined();
  });

  it("reads each duration unit, and a bare number as days", () => {
    expect(parseDuration("5d")).toBe(5 * DAY);
    expect(parseDuration("2w")).toBe(14 * DAY);
    expect(parseDuration("36h")).toBe(36 * 3_600_000);
    expect(parseDuration("30")).toBe(30 * DAY);
  });

  it("steps an axis by whole months over a long span", () => {
    // Advancing by thirty days instead drifts off the first of the month within a year.
    const ticks = axisTicks(Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1), 12);
    expect(ticks.length).toBeGreaterThan(6);
    for (const tick of ticks) {
      expect(new Date(tick).getUTCDate()).toBe(1);
    }
  });

  it("keeps an axis under the tick budget", () => {
    const ticks = axisTicks(Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), 6);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });
});

describe("gantt", () => {
  const parse = (source: string): GanttDiagram => parseMermaid(source) as GanttDiagram;

  it("classifies fields by what they say, not by where they sit", () => {
    // `Task : a1, 2024-01-01, 30d` and `Task : 2024-01-01, 30d` have the same shape until
    // each field is read.
    const withId = parse("gantt\n section S\n Task :a1, 2024-01-01, 30d").tasks[0];
    const without = parse("gantt\n section S\n Task :2024-01-01, 30d").tasks[0];
    expect(withId.id).toBe("a1");
    expect(withId.start).toBe(Date.UTC(2024, 0, 1));
    expect(withId.end).toBe(Date.UTC(2024, 0, 31));
    expect(without.id).toBeUndefined();
    expect(without.start).toBe(withId.start);
  });

  it("starts a dependent task when the one it waits on ends", () => {
    const tasks = parse(`gantt
      section S
      One :a, 2024-01-01, 10d
      Two :after a, 5d`).tasks;
    expect(tasks[1].start).toBe(tasks[0].end);
    expect(tasks[1].end).toBe(tasks[0].end + 5 * DAY);
  });

  it("waits for the last of several dependencies", () => {
    // The longer task is named *first*, so taking whichever is mentioned first would give
    // the same answer as taking the latest and prove nothing.
    const tasks = parse(`gantt
      section S
      Long :a, 2024-01-01, 20d
      Short :b, 2024-01-01, 5d
      Third :after a b, 1d`).tasks;
    expect(tasks[2].start).toBe(tasks[0].end);
    expect(tasks[2].start).toBeGreaterThan(tasks[1].end);
  });

  it("continues from the previous task when a start is not given", () => {
    const tasks = parse(`gantt
      section S
      One :2024-01-01, 10d
      Two :5d`).tasks;
    expect(tasks[1].start).toBe(tasks[0].end);
  });

  it("reads the state tags and the milestone marker", () => {
    const tasks = parse(`gantt
      section S
      A :done, 2024-01-01, 1d
      B :active, 1d
      C :crit, 1d
      D :milestone, 0d`).tasks;
    expect(tasks.map(task => task.state)).toEqual(["done", "active", "crit", "default"]);
    expect(tasks[3].milestone).toBe(true);
    // A milestone is an instant, so it has no width to draw.
    expect(tasks[3].start).toBe(tasks[3].end);
  });

  it("keeps sections in declaration order", () => {
    expect(parse("gantt\n section B\n x :2024-01-01, 1d\n section A\n y :1d").sections).toEqual([
      "B",
      "A"
    ]);
  });

  it("draws a diamond for a milestone and a bar for a task", () => {
    const list = mermaidToDrawList("gantt\n section S\n A :2024-01-01, 5d\n B :milestone, 0d");
    const diamonds = list.children.filter(
      node => node.kind === "polyline" && node.closed === true && node.points.length === 4
    );
    expect(diamonds).toHaveLength(1);
  });

  it("scales bars to the span, so a longer task is a wider bar", () => {
    const list = mermaidToDrawList(`gantt
      section S
      Short :2024-01-01, 5d
      Long :2024-01-01, 20d`);
    const bars = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect" && node.rx === 3
    );
    expect(bars).toHaveLength(2);
    expect(bars[1].width).toBeGreaterThan(bars[0].width * 3);
  });
});

describe("timeline", () => {
  const parse = (source: string): TimelineDiagram => parseMermaid(source) as TimelineDiagram;

  it("reads several events against one period", () => {
    const period = parse("timeline\n 2004 : Facebook : Google").periods[0];
    expect(period.label).toBe("2004");
    expect(period.events).toEqual(["Facebook", "Google"]);
  });

  it("adds a continuation line's events to the period above it", () => {
    const periods = parse("timeline\n 2004 : Facebook\n      : Google").periods;
    expect(periods).toHaveLength(1);
    expect(periods[0].events).toEqual(["Facebook", "Google"]);
  });

  it("keeps each period in the section it was declared under", () => {
    const diagram = parse(`timeline
      section Early
        2002 : LinkedIn
      section Growth
        2005 : YouTube`);
    expect(diagram.periods.map(period => period.section)).toEqual(["Early", "Growth"]);
    expect(diagram.sections).toEqual(["Early", "Growth"]);
  });

  it("stacks a period's events instead of overlapping them", () => {
    const list = mermaidToDrawList("timeline\n 2004 : One : Two : Three");
    const boxes = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect" && node.rx === 4
    );
    expect(boxes).toHaveLength(3);
    const tops = boxes.map(box => box.y).sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
  });
});

describe("journey", () => {
  const parse = (source: string): JourneyDiagram => parseMermaid(source) as JourneyDiagram;

  it("reads the score and the cast", () => {
    const task = parse("journey\n Make tea: 5: Me, Cat").tasks[0];
    expect([task.label, task.score, task.actors]).toEqual(["Make tea", 5, ["Me", "Cat"]]);
  });

  it("clamps a score outside the scale rather than dropping the step", () => {
    // The step happened; only its score is unreadable.
    expect(parse("journey\n A: 9: Me").tasks[0].score).toBe(5);
    expect(parse("journey\n A: 0: Me").tasks[0].score).toBe(1);
  });

  it("plots a higher score higher up", () => {
    const list = mermaidToDrawList("journey\n Low: 1: Me\n High: 5: Me");
    const dots = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "ellipse" }> =>
        node.kind === "ellipse" && node.rx === 9
    );
    expect(dots).toHaveLength(2);
    expect(dots[1].cy).toBeLessThan(dots[0].cy);
  });
});

describe("mindmap", () => {
  const parse = (source: string): MindmapDiagram => parseMermaid(source) as MindmapDiagram;

  it("takes its structure from the indentation", () => {
    const diagram = parse(`mindmap
  root
    A
      A1
    B`);
    expect(diagram.root?.text).toBe("root");
    expect(diagram.root?.children.map(child => child.text)).toEqual(["A", "B"]);
    expect(diagram.root?.children[0].children.map(child => child.text)).toEqual(["A1"]);
  });

  it("unwinds to the right parent when the indentation goes back out", () => {
    const diagram = parse(`mindmap
  root
    A
      A1
        A2
    B`);
    expect(diagram.root?.children.map(child => child.text)).toEqual(["A", "B"]);
  });

  it("reads the bracket shapes", () => {
    const diagram = parse(`mindmap
  root((circle))
    a[square]
    b(rounded)
    c{{hex}}`);
    expect(diagram.root?.shape).toBe("circle");
    expect(diagram.root?.children.map(child => child.shape)).toEqual([
      "square",
      "rounded",
      "hexagon"
    ]);
  });

  it("splits the root's children between the two sides", () => {
    // Growing outwards from the middle is what makes it a mind map rather than a tree.
    const list = mermaidToDrawList("mindmap\n root\n  A\n  B\n  C\n  D");
    const boxes = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "rect" }> => node.kind === "rect"
    );
    // Four children, so two boxes each side of the root's own.
    const centre = list.width / 2;
    expect(boxes.filter(box => box.x + box.width < centre)).toHaveLength(2);
    expect(boxes.filter(box => box.x > centre)).toHaveLength(2);
  });
});

describe("gitGraph", () => {
  const parse = (source: string): GitGraphDiagram => parseMermaid(source) as GitGraphDiagram;

  it("switches to a branch as it creates it", () => {
    const diagram = parse("gitGraph\n commit\n branch dev\n commit");
    expect(diagram.commits.map(commit => commit.branch)).toEqual(["main", "dev"]);
  });

  it("records what a merge came from", () => {
    const diagram = parse(`gitGraph
      commit
      branch dev
      commit
      checkout main
      merge dev`);
    const merge = diagram.commits.at(-1)!;
    expect([merge.kind, merge.branch, merge.from]).toEqual(["merge", "main", "dev"]);
  });

  it("reads id, tag and type", () => {
    const diagram = parse(`gitGraph
      commit id: "first" tag: "v1"
      commit type: HIGHLIGHT
      commit type: REVERSE`);
    expect(diagram.commits[0].id).toBe("first");
    expect(diagram.commits[0].tag).toBe("v1");
    expect(diagram.commits[1].highlight).toBe(true);
    expect(diagram.commits[2].reverse).toBe(true);
  });

  it("drops a branch nobody committed to rather than drawing an empty lane", () => {
    expect(parse("gitGraph\n commit\n branch dev\n checkout main\n commit").branches).toEqual([
      "main"
    ]);
  });

  it("gives each branch its own lane", () => {
    const list = mermaidToDrawList("gitGraph\n commit\n branch dev\n commit");
    const dots = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "ellipse" }> => node.kind === "ellipse"
    );
    expect(dots).toHaveLength(2);
    expect(dots[0].cy).not.toBe(dots[1].cy);
  });

  it("draws an arc from the branch a merge came from", () => {
    const plain = mermaidToDrawList("gitGraph\n commit\n branch dev\n commit");
    const merged = mermaidToDrawList(
      "gitGraph\n commit\n branch dev\n commit\n checkout main\n merge dev"
    );
    const paths = (list: typeof plain): number =>
      list.children.filter(node => node.kind === "path").length;
    expect(paths(merged)).toBe(paths(plain) + 1);
  });
});
