/**
 * The diagram types beyond flowchart and pie.
 *
 * Each is checked at both ends: that the parser reads what the source says, and that the
 * marks which carry the *meaning* reach the display list. In a class diagram the
 * difference between inheritance and composition is a hollow triangle against a filled
 * diamond, and in an ER diagram between "one" and "many" is a bar against a crow's foot —
 * a picture that drew the wrong one would be worse than one that drew nothing.
 */
import type { DrawNode } from "@draw/types";
import { mermaidToDrawList, parseMermaid } from "@mermaid/index";
import type {
  ClassDiagram,
  ErDiagram,
  SequenceBlock,
  SequenceDiagram,
  SequenceNote,
  StateDiagram
} from "@mermaid/types";
import { describe, expect, it } from "vitest";

describe("sequenceDiagram blocks and notes", () => {
  const parse = (source: string): SequenceDiagram => parseMermaid(source) as SequenceDiagram;

  it("keeps a block's branches in one frame", () => {
    // `alt`/`else` is one decision with two outcomes, not two independent frames.
    const diagram = parse(`sequenceDiagram
      alt accepted
        A->>B: yes
      else declined
        A->>B: no
      end`);
    expect(diagram.body).toHaveLength(1);
    const block = diagram.body[0] as SequenceBlock;
    expect(block.keyword).toBe("alt");
    expect(block.sections.map(section => section.label)).toEqual(["accepted", "declined"]);
    expect(block.sections.map(section => section.body.length)).toEqual([1, 1]);
  });

  it("nests a block inside a block", () => {
    const diagram = parse(`sequenceDiagram
      loop retry
        opt cached
          A->>B: hit
        end
      end`);
    const outer = diagram.body[0] as SequenceBlock;
    expect(outer.keyword).toBe("loop");
    expect((outer.sections[0].body[0] as SequenceBlock).keyword).toBe("opt");
  });

  it("still reports every message flat, whatever it is nested in", () => {
    // The common question is "what talks to what"; rebuilding that from the tree at each
    // call site is the work a parser exists to do once.
    const diagram = parse(`sequenceDiagram
      A->>B: one
      alt x
        B->>C: two
      end`);
    expect(diagram.messages.map(message => message.text)).toEqual(["one", "two"]);
  });

  it("reads both note placements and the participants they name", () => {
    const diagram = parse(`sequenceDiagram
      Note right of A: beside
      Note over A,B: across`);
    const notes = diagram.body as SequenceNote[];
    expect(notes.map(note => `${note.placement}:${note.participants.join()}:${note.text}`)).toEqual(
      ["right:A:beside", "over:A,B:across"]
    );
  });

  it("declares a participant a note names but no message mentions", () => {
    expect(parse("sequenceDiagram\n Note over Solo: alone").participants.map(p => p.id)).toEqual([
      "Solo"
    ]);
  });

  it("frames a block that was never closed rather than dropping its messages", () => {
    const diagram = parse("sequenceDiagram\n loop forever\n  A->>B: tick");
    expect(diagram.messages).toHaveLength(1);
    expect((diagram.body[0] as SequenceBlock).keyword).toBe("loop");
  });

  it("numbers messages when asked", () => {
    const list = mermaidToDrawList("sequenceDiagram\n autonumber\n A->>B: one\n B->>A: two");
    const labels = list.children
      .filter(node => node.kind === "text")
      .flatMap(node => node.lines.map(line => line.text));
    expect(labels).toContain("1. one");
    expect(labels).toContain("2. two");
  });

  it("draws a frame for each block", () => {
    const plain = mermaidToDrawList("sequenceDiagram\n A->>B: one");
    const framed = mermaidToDrawList("sequenceDiagram\n loop x\n  A->>B: one\n end");
    const rects = (list: typeof plain): number =>
      list.children.filter(node => node.kind === "rect").length;
    expect(rects(framed)).toBeGreaterThan(rects(plain));
  });
});

describe("stateDiagram", () => {
  const parse = (source: string): StateDiagram => parseMermaid(source) as StateDiagram;

  it("gives each [*] its own node", () => {
    // Sharing one would wire every ending to every beginning, drawing transitions the
    // source never wrote.
    const diagram = parse("stateDiagram-v2\n [*] --> A\n A --> [*]");
    const markers = diagram.states.filter(state => state.marker !== "none");
    expect(markers.map(state => state.marker)).toEqual(["start", "end"]);
    expect(diagram.transitions).toHaveLength(2);
    expect(diagram.transitions[0].from).not.toBe(diagram.transitions[1].to);
  });

  it("reads a transition label", () => {
    expect(parse("stateDiagram-v2\n A --> B : go").transitions[0].label).toBe("go");
  });

  it("takes a description from either spelling", () => {
    expect(parse('stateDiagram-v2\n state "Long name" as s1\n s1 --> B').states[0].text).toBe(
      "Long name"
    );
    expect(parse("stateDiagram-v2\n A --> B\n A : waiting").states[0].text).toBe("waiting");
  });

  it("groups a composite state", () => {
    const diagram = parse(`stateDiagram-v2
      [*] --> Outer
      state Outer {
        A --> B
      }`);
    expect(diagram.composites[0].nodeIds).toEqual(["A", "B"]);
  });

  it("draws a marker as a disc with no text", () => {
    const list = mermaidToDrawList("stateDiagram-v2\n [*] --> A");
    const discs = list.children.filter(node => node.kind === "ellipse");
    expect(discs.length).toBeGreaterThanOrEqual(1);
    const labels = list.children
      .filter(node => node.kind === "text")
      .flatMap(node => node.lines.map(line => line.text));
    expect(labels.some(text => text.startsWith("__"))).toBe(false);
  });
});

describe("classDiagram", () => {
  const parse = (source: string): ClassDiagram => parseMermaid(source) as ClassDiagram;

  it("normalises an arrow so the mark is always at `to`", () => {
    // `A <|-- B` and `B --|> A` say the same thing from opposite ends.
    const one = parse("classDiagram\n Animal <|-- Duck").links[0];
    const other = parse("classDiagram\n Duck --|> Animal").links[0];
    expect(`${one.from}->${one.to}:${one.relation}`).toBe("Duck->Animal:inheritance");
    expect(`${other.from}->${other.to}:${other.relation}`).toBe(
      `${one.from}->${one.to}:${one.relation}`
    );
  });

  it("reads each relationship", () => {
    const relations = parse(`classDiagram
      A <|-- B
      A *-- C
      A o-- D
      A --> E
      A ..> F
      A <|.. G`).links.map(link => link.relation);
    expect(relations).toEqual([
      "inheritance",
      "composition",
      "aggregation",
      "association",
      "dependency",
      "realization"
    ]);
  });

  it("reads multiplicities from the side they were written on", () => {
    const link = parse('classDiagram\n Animal "1" *-- "0..*" Leg').links[0];
    // Reversed by the arrow, so the multiplicities swap with the ends.
    expect(`${link.from}:${link.fromCardinality} ${link.to}:${link.toCardinality}`).toBe(
      "Leg:0..* Animal:1"
    );
  });

  it("collects members from a block and from single statements alike", () => {
    const diagram = parse(`classDiagram
      class Animal {
        +String name
        +move() bool
      }
      Animal : -int age`);
    expect(diagram.classes[0].members.map(m => `${m.visibility}:${m.method}:${m.text}`)).toEqual([
      "public:false:String name",
      "public:true:move() bool",
      "private:false:int age"
    ]);
  });

  it("reads a stereotype", () => {
    expect(
      parse("classDiagram\n class F {\n <<interface>>\n +fly()\n }").classes[0].stereotype
    ).toBe("interface");
  });

  it("draws a hollow triangle for inheritance and a filled diamond for composition", () => {
    const inherit = mermaidToDrawList("classDiagram\n A <|-- B");
    const compose = mermaidToDrawList("classDiagram\n A *-- B");
    const closed = (
      list: typeof inherit,
      points: number
    ): Array<Extract<DrawNode, { kind: "polyline" }>> =>
      list.children.filter(
        (node): node is Extract<DrawNode, { kind: "polyline" }> =>
          node.kind === "polyline" && node.closed === true && node.points.length === points
      );
    expect(closed(inherit, 3)).toHaveLength(1);
    expect(closed(compose, 4)).toHaveLength(1);
    // The diamond is filled and the triangle is not, which is the whole distinction.
    expect(closed(compose, 4)[0].paint.fill).toBeDefined();
  });

  it("separates fields from methods with a rule", () => {
    const list = mermaidToDrawList("classDiagram\n class A {\n +f\n +m()\n }");
    const rules = list.children.filter(
      node => node.kind === "polyline" && node.points.length === 2 && node.paint.fill === undefined
    );
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });
});

describe("erDiagram", () => {
  const parse = (source: string): ErDiagram => parseMermaid(source) as ErDiagram;

  it("reads each side's cardinality against its own spelling", () => {
    // `|o` and `o|` are the same cardinality written from opposite ends.
    const relation = parse("erDiagram\n A ||--o{ B : has").relations[0];
    expect(`${relation.fromCardinality}/${relation.toCardinality}`).toBe("exactlyOne/zeroOrMore");
    const mirrored = parse("erDiagram\n A }|--|| B : has").relations[0];
    expect(`${mirrored.fromCardinality}/${mirrored.toCardinality}`).toBe("oneOrMore/exactlyOne");
  });

  it("tells an identifying relationship from a non-identifying one", () => {
    expect(parse("erDiagram\n A ||--|| B : x").relations[0].identifying).toBe(true);
    expect(parse("erDiagram\n A ||..|| B : x").relations[0].identifying).toBe(false);
  });

  it("reads attributes with their keys and comment", () => {
    const entity = parse(`erDiagram
      CUSTOMER {
        string name PK "the key"
        int points
      }`).entities[0];
    expect(
      entity.attributes.map(a => `${a.type}/${a.name}/${a.keys.join()}/${a.comment ?? "-"}`)
    ).toEqual(["string/name/PK/the key", "int/points//-"]);
  });

  it("draws more marks for a crow's foot than for a bar", () => {
    const many = mermaidToDrawList("erDiagram\n A ||--o{ B : has");
    const one = mermaidToDrawList("erDiagram\n A ||--|| B : has");
    const strokes = (list: typeof many): number =>
      list.children.filter(node => node.kind === "polyline" && node.points.length === 2).length;
    expect(strokes(many)).toBeGreaterThan(strokes(one));
  });

  it("draws a circle for an optional end and none for a mandatory one", () => {
    const optional = mermaidToDrawList("erDiagram\n A ||--o| B : has");
    const mandatory = mermaidToDrawList("erDiagram\n A ||--|| B : has");
    const circles = (list: typeof optional): number =>
      list.children.filter(node => node.kind === "ellipse").length;
    expect(circles(optional)).toBe(1);
    expect(circles(mandatory)).toBe(0);
  });
});

describe("edges arriving at one node", () => {
  it("gives each its own place on the border", () => {
    // Bending at the midpoint of the flow axis sent every incoming edge to the centre of
    // its target's leading edge, so three parents put three arrowheads on one pixel — and
    // in a class diagram the marks that tell the relationships apart landed on each other.
    const list = mermaidToDrawList("flowchart TD\n A --> D\n B --> D\n C --> D");
    const heads = list.children.filter(
      (node): node is Extract<DrawNode, { kind: "polyline" }> =>
        node.kind === "polyline" && node.closed === true && node.points.length === 3
    );
    expect(heads).toHaveLength(3);
    const tips = new Set(heads.map(head => Math.round(head.points[0].x)));
    expect(tips.size).toBe(3);
  });
});
