/**
 * The parsed form of a Mermaid diagram.
 *
 * A syntax tree rather than a picture: nothing here says where anything sits or what
 * colour it is. Layout and paint are separate passes, so a caller can inspect what was
 * written, rewrite it, or lay it out under its own rules without re-parsing.
 */

/** Which way a flowchart grows. */
export type FlowDirection = "TB" | "BT" | "LR" | "RL";

/**
 * A node's outline.
 *
 * Mermaid spells these with bracket pairs — `[]` for a box, `{}` for a rhombus, `(())`
 * for a circle. The name is the shape, not the spelling, because several spellings
 * produce the same outline (`TB` and `TD`; `[/…/]` and `[\…\]` differ only in slant).
 */
export type FlowShape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "doubleCircle"
  | "asymmetric"
  | "rhombus"
  | "hexagon"
  | "parallelogram"
  | "parallelogramAlt"
  | "trapezoid"
  | "trapezoidAlt"
  /** A state machine's entry point: a small filled disc. */
  | "stateStart"
  /** Its exit: a disc inside a ring. */
  | "stateEnd";

/** One node of a flowchart. */
export interface FlowNode {
  /** The identifier written in the source; unique within the diagram. */
  readonly id: string;
  /** Display text. Defaults to the id when the node is only ever referenced. */
  readonly text: string;
  readonly shape: FlowShape;
  /** `class` names attached with `:::name` or a `class` statement. */
  readonly classes: readonly string[];
}

/** How an edge is drawn. */
export type EdgeStroke = "solid" | "dotted" | "thick";

/** What an edge carries at an end. */
export type EdgeEnd = "none" | "arrow" | "circle" | "cross";

/** One edge of a flowchart. */
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly stroke: EdgeStroke;
  /** Decoration at the source end; `none` unless the edge is bidirectional. */
  readonly startEnd: EdgeEnd;
  readonly endEnd: EdgeEnd;
  readonly label?: string;
  /**
   * Extra rank distance requested by a longer arrow (`---->` versus `-->`).
   *
   * Mermaid reads each additional dash as a request for one more rank, which is how an
   * author keeps two branches of unequal length level with each other.
   */
  readonly minRankSpan: number;
}

/** A named group drawn as a labelled box around its members. */
export interface FlowSubgraph {
  readonly id: string;
  readonly text: string;
  readonly nodeIds: readonly string[];
  /**
   * The group this one sits inside, when it was declared nested.
   *
   * Needed because membership alone cannot tell nesting from coincidence: two groups
   * holding the same nodes are indistinguishable by their members, and drawing their frames
   * at the same size makes the containment invisible.
   */
  readonly parent?: string;
}

/** A `classDef` — the styling half of Mermaid's class mechanism. */
export interface ClassDef {
  readonly name: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly color?: string;
  readonly strokeWidth?: number;
  readonly strokeDasharray?: readonly number[];
}

/** A parsed flowchart. */
export interface FlowchartDiagram {
  readonly kind: "flowchart";
  readonly direction: FlowDirection;
  readonly title?: string;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly subgraphs: readonly FlowSubgraph[];
  readonly classDefs: readonly ClassDef[];
}

/** One slice of a `pie` diagram. */
export interface PieSlice {
  readonly label: string;
  readonly value: number;
}

/** A parsed pie chart. */
export interface PieDiagram {
  readonly kind: "pie";
  readonly title?: string;
  /** `pie showData` prints each slice's value beside its name. */
  readonly showData: boolean;
  readonly slices: readonly PieSlice[];
}

/** One participant of a sequence diagram, in declaration order. */
export interface SequenceParticipant {
  readonly id: string;
  readonly text: string;
  /** `actor A` draws a stick figure instead of a box. */
  readonly actor: boolean;
}

/** The line style of a sequence message. */
export type SequenceLine = "solid" | "dotted";

/** One message of a sequence diagram. */
export interface SequenceMessage {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly line: SequenceLine;
  readonly arrow: EdgeEnd;
  /** `A->>+B` — the message activates its target. */
  readonly activates?: boolean;
  /** `B-->>-A` — the message ends the sender's activation. */
  readonly deactivates?: boolean;
}

/** Where a note sits relative to the participants it names. */
export type NotePlacement = "left" | "right" | "over";

/** A note attached to one or two participants. */
export interface SequenceNote {
  readonly kind: "note";
  readonly placement: NotePlacement;
  /** One participant, or the two a spanning note is drawn across. */
  readonly participants: readonly string[];
  readonly text: string;
}

/** A message, as an entry in the ordered body of a diagram or a block. */
export interface SequenceMessageEntry extends SequenceMessage {
  readonly kind: "message";
}

/**
 * A framed group: `loop`, `alt`/`else`, `opt`, `par`/`and`, `critical`, `break`.
 *
 * Sections model `alt`/`else` and `par`/`and`, which are one frame divided by a rule
 * rather than several frames — drawing them as separate boxes would lose the fact that
 * the branches are alternatives of the same decision.
 */
export interface SequenceBlock {
  readonly kind: "block";
  /** `loop`, `alt`, `opt`, `par`, `critical`, `break`. */
  readonly keyword: string;
  readonly sections: readonly SequenceSection[];
}

/** One branch of a block; the first carries the block's own label. */
export interface SequenceSection {
  readonly label: string;
  readonly body: readonly SequenceEntry[];
}

/** Anything that can appear in a diagram's body, in source order. */
export type SequenceEntry = SequenceMessageEntry | SequenceNote | SequenceBlock;

/** A parsed sequence diagram. */
export interface SequenceDiagram {
  readonly kind: "sequence";
  readonly title?: string;
  readonly participants: readonly SequenceParticipant[];
  /**
   * Every message, flattened, in source order.
   *
   * Kept alongside {@link body} because the common question — "what talks to what" — is
   * answered by the flat list, and reconstructing it from the tree at every call site
   * would be the sort of work a parser exists to do once.
   */
  readonly messages: readonly SequenceMessage[];
  /** The diagram's body as written, with blocks and notes in place. */
  readonly body: readonly SequenceEntry[];
  /** `autonumber` was requested, so messages are numbered as they are drawn. */
  readonly autonumber: boolean;
}

/**
 * A parsed state diagram.
 *
 * Structurally a flowchart — states are nodes, transitions are edges, composite states are
 * groups — so it is laid out and drawn by the same passes. The type is separate because
 * the *source* is a different language and a caller inspecting the tree should see what
 * they wrote; the conversion happens on the way to layout, not on the way out of the
 * parser.
 */
export interface StateDiagram {
  readonly kind: "state";
  readonly direction: FlowDirection;
  readonly title?: string;
  readonly states: readonly StateNode[];
  readonly transitions: readonly StateTransition[];
  readonly composites: readonly FlowSubgraph[];
}

/** One state. */
export interface StateNode {
  readonly id: string;
  readonly text: string;
  /** `[*]` is drawn as a start or end marker rather than as a box. */
  readonly marker: "none" | "start" | "end";
  /** `<<choice>>` and `<<fork>>` / `<<join>>` have outlines of their own. */
  readonly stereotype?: "choice" | "fork" | "join";
}

/** One transition. */
export interface StateTransition {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

/** How a class member may be reached. */
export type Visibility = "public" | "private" | "protected" | "package" | "none";

/** One field or method of a class. */
export interface ClassMember {
  readonly text: string;
  readonly visibility: Visibility;
  /** A method is drawn in the lower compartment, a field in the upper one. */
  readonly method: boolean;
}

/** One class box. */
export interface ClassBox {
  readonly id: string;
  readonly name: string;
  /** `<<interface>>`, `<<abstract>>`, `<<enumeration>>`. */
  readonly stereotype?: string;
  readonly members: readonly ClassMember[];
}

/**
 * How two classes relate.
 *
 * Named for the relationship rather than the marks, because the marks differ per end:
 * `inheritance` is a hollow triangle at the parent, `composition` a filled diamond at the
 * whole, and so on.
 */
export type ClassRelation =
  | "inheritance"
  | "composition"
  | "aggregation"
  | "association"
  | "dependency"
  | "realization"
  | "link";

/** One relationship between two classes. */
export interface ClassLink {
  readonly from: string;
  readonly to: string;
  readonly relation: ClassRelation;
  /** Multiplicity written beside each end, e.g. `"1"` and `"0..*"`. */
  readonly fromCardinality?: string;
  readonly toCardinality?: string;
  readonly label?: string;
}

/** A parsed class diagram. */
export interface ClassDiagram {
  readonly kind: "class";
  readonly direction: FlowDirection;
  readonly title?: string;
  readonly classes: readonly ClassBox[];
  readonly links: readonly ClassLink[];
}

/** One column of an entity. */
export interface EntityAttribute {
  readonly type: string;
  readonly name: string;
  /** `PK`, `FK`, `UK`. */
  readonly keys: readonly string[];
  readonly comment?: string;
}

/** One entity. */
export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly attributes: readonly EntityAttribute[];
}

/**
 * How many of one entity relate to one of the other.
 *
 * Named rather than spelled, because the same cardinality has two spellings depending on
 * which side of the relationship it is written on (`|o` and `o|`).
 */
export type Cardinality = "zeroOrOne" | "exactlyOne" | "zeroOrMore" | "oneOrMore";

/** One relationship. */
export interface EntityRelation {
  readonly from: string;
  readonly to: string;
  readonly fromCardinality: Cardinality;
  readonly toCardinality: Cardinality;
  /** A dashed line means the child does not need the parent to exist. */
  readonly identifying: boolean;
  readonly label?: string;
}

/** A parsed entity-relationship diagram. */
export interface ErDiagram {
  readonly kind: "er";
  readonly direction: FlowDirection;
  readonly title?: string;
  readonly entities: readonly Entity[];
  readonly relations: readonly EntityRelation[];
}

/** How a Gantt task is drawn. */
export type TaskState = "default" | "active" | "done" | "crit";

/** One bar of a Gantt chart. */
export interface GanttTask {
  readonly id?: string;
  readonly label: string;
  readonly section: string;
  /** UTC milliseconds. */
  readonly start: number;
  readonly end: number;
  readonly state: TaskState;
  /** A zero-length task, drawn as a marker rather than a bar. */
  readonly milestone: boolean;
}

/** A parsed Gantt chart. */
export interface GanttDiagram {
  readonly kind: "gantt";
  readonly title?: string;
  /** Section names in the order they were declared. */
  readonly sections: readonly string[];
  readonly tasks: readonly GanttTask[];
}

/** One point on a timeline: a period and everything recorded against it. */
export interface TimelinePeriod {
  readonly label: string;
  readonly events: readonly string[];
  /** The section this period falls in, `""` when none was declared. */
  readonly section: string;
}

/** A parsed timeline. */
export interface TimelineDiagram {
  readonly kind: "timeline";
  readonly title?: string;
  readonly sections: readonly string[];
  readonly periods: readonly TimelinePeriod[];
}

/** One step of a user journey. */
export interface JourneyTask {
  readonly label: string;
  readonly section: string;
  /** Mermaid scores satisfaction from 1 to 5. */
  readonly score: number;
  readonly actors: readonly string[];
}

/** A parsed user journey. */
export interface JourneyDiagram {
  readonly kind: "journey";
  readonly title?: string;
  readonly sections: readonly string[];
  readonly tasks: readonly JourneyTask[];
}

/** How a mind-map node is drawn; `[]`, `()`, `(())`, `))((`, `{{}}`. */
export type MindShape = "default" | "square" | "rounded" | "circle" | "bang" | "cloud" | "hexagon";

/** One node of a mind map, with its children. */
export interface MindNode {
  readonly text: string;
  readonly shape: MindShape;
  readonly children: readonly MindNode[];
}

/** A parsed mind map. */
export interface MindmapDiagram {
  readonly kind: "mindmap";
  readonly title?: string;
  readonly root?: MindNode;
}

/** One commit of a git graph. */
export interface GitCommit {
  readonly kind: "commit" | "merge";
  readonly id: string;
  readonly branch: string;
  /** The branch merged in, for a merge commit. */
  readonly from?: string;
  readonly tag?: string;
  /** `HIGHLIGHT` and `REVERSE` change the mark, not the shape of the graph. */
  readonly highlight: boolean;
  readonly reverse: boolean;
}

/** A parsed git graph. */
export interface GitGraphDiagram {
  readonly kind: "git";
  readonly title?: string;
  /** Branch names in the order they first appear, which is the order of the lanes. */
  readonly branches: readonly string[];
  readonly commits: readonly GitCommit[];
}

/** One plotted point of a quadrant chart; both coordinates run 0..1. */
export interface QuadrantPoint {
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/** A parsed quadrant chart. */
export interface QuadrantDiagram {
  readonly kind: "quadrant";
  readonly title?: string;
  /** Axis captions, low end first. */
  readonly xAxis?: readonly [string, string];
  readonly yAxis?: readonly [string, string];
  /** Quadrant names, in Mermaid's order: top-right, top-left, bottom-left, bottom-right. */
  readonly quadrants: readonly [string, string, string, string];
  readonly points: readonly QuadrantPoint[];
}

/** One series of an XY chart. */
export interface XySeries {
  readonly type: "bar" | "line";
  readonly title?: string;
  readonly values: readonly number[];
}

/** A parsed XY chart. */
export interface XyDiagram {
  readonly kind: "xy";
  readonly title?: string;
  readonly horizontal: boolean;
  readonly xTitle?: string;
  readonly yTitle?: string;
  /** Category names, when the x axis is categorical. */
  readonly categories: readonly string[];
  /** Explicit y bounds, when the source pinned them. */
  readonly yRange?: readonly [number, number];
  readonly series: readonly XySeries[];
}

/** One link of a Sankey diagram. */
export interface SankeyLink {
  readonly from: string;
  readonly to: string;
  readonly value: number;
}

/** A parsed Sankey diagram. */
export interface SankeyDiagram {
  readonly kind: "sankey";
  readonly title?: string;
  readonly links: readonly SankeyLink[];
}

/** One requirement box. */
export interface Requirement {
  readonly id: string;
  readonly name: string;
  /** `requirement`, `functionalRequirement`, `performanceRequirement`, … */
  readonly type: string;
  readonly text?: string;
  readonly risk?: string;
  readonly verifyMethod?: string;
}

/** Something a requirement is about. */
export interface RequirementElement {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly docRef?: string;
}

/** One relationship: `satisfies`, `traces`, `contains`, … */
export interface RequirementLink {
  readonly from: string;
  readonly to: string;
  readonly verb: string;
}

/** A parsed requirement diagram. */
export interface RequirementDiagram {
  readonly kind: "requirement";
  readonly title?: string;
  readonly requirements: readonly Requirement[];
  readonly elements: readonly RequirementElement[];
  readonly links: readonly RequirementLink[];
}

/** One participant of a C4 diagram. */
export interface C4Element {
  readonly id: string;
  /** `Person`, `System`, `Container`, `Component`, and their `_Ext` variants. */
  readonly type: string;
  readonly label: string;
  readonly technology?: string;
  readonly description?: string;
  /** The boundary this element sits in, when one was declared. */
  readonly boundary?: string;
}

/** A boundary drawn around a group of elements. */
export interface C4Boundary {
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

/** One arrow of a C4 diagram. */
export interface C4Relation {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly technology?: string;
  /** `Rel_Back` and the directional variants point the other way. */
  readonly reversed: boolean;
}

/** A parsed C4 diagram. */
export interface C4Diagram {
  readonly kind: "c4";
  readonly title?: string;
  readonly elements: readonly C4Element[];
  readonly boundaries: readonly C4Boundary[];
  readonly relations: readonly C4Relation[];
}

/** One cell of a block diagram. */
export interface BlockCell {
  readonly id: string;
  readonly label: string;
  readonly shape: FlowShape;
  /** How many columns of the current row this cell spans. */
  readonly span: number;
  /** A spacer holds a gap open without drawing anything. */
  readonly spacer: boolean;
}

/** A parsed block diagram. */
export interface BlockDiagram {
  readonly kind: "block";
  readonly title?: string;
  readonly columns: number;
  readonly cells: readonly BlockCell[];
  readonly edges: readonly FlowEdge[];
}

/** One field of a packet diagram. */
export interface PacketField {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/** A parsed packet diagram. */
export interface PacketDiagram {
  readonly kind: "packet";
  readonly title?: string;
  /** Bits per row; Mermaid's default is 32. */
  readonly bitsPerRow: number;
  readonly fields: readonly PacketField[];
}

/** One card on a kanban board. */
export interface KanbanCard {
  readonly id: string;
  readonly text: string;
  readonly assigned?: string;
  readonly priority?: string;
  readonly ticket?: string;
}

/** One column of a kanban board. */
export interface KanbanColumn {
  readonly id: string;
  readonly title: string;
  readonly cards: readonly KanbanCard[];
}

/** A parsed kanban board. */
export interface KanbanDiagram {
  readonly kind: "kanban";
  readonly title?: string;
  readonly columns: readonly KanbanColumn[];
}

/** One series of a radar chart. */
export interface RadarSeries {
  readonly label: string;
  readonly values: readonly number[];
}

/** A parsed radar chart. */
export interface RadarDiagram {
  readonly kind: "radar";
  readonly title?: string;
  readonly axes: readonly string[];
  readonly series: readonly RadarSeries[];
  readonly max?: number;
}

/** One service or group of an architecture diagram. */
export interface ArchitectureNode {
  readonly id: string;
  readonly label: string;
  /** The icon name Mermaid was given; drawn as a caption rather than a glyph. */
  readonly icon?: string;
  readonly group?: string;
  readonly isGroup: boolean;
}

/** One connection of an architecture diagram. */
export interface ArchitectureEdge {
  readonly from: string;
  readonly to: string;
  /** Which side each end leaves from: `L`, `R`, `T`, `B`. */
  readonly fromSide?: string;
  readonly toSide?: string;
  readonly arrow: boolean;
}

/** A parsed architecture diagram. */
export interface ArchitectureDiagram {
  readonly kind: "architecture";
  readonly title?: string;
  readonly nodes: readonly ArchitectureNode[];
  readonly edges: readonly ArchitectureEdge[];
}

/** Any diagram this module understands. */
export type MermaidDiagram =
  | FlowchartDiagram
  | PieDiagram
  | SequenceDiagram
  | StateDiagram
  | ClassDiagram
  | ErDiagram
  | GanttDiagram
  | TimelineDiagram
  | JourneyDiagram
  | MindmapDiagram
  | GitGraphDiagram
  | QuadrantDiagram
  | XyDiagram
  | SankeyDiagram
  | RequirementDiagram
  | C4Diagram
  | BlockDiagram
  | PacketDiagram
  | KanbanDiagram
  | RadarDiagram
  | ArchitectureDiagram;
