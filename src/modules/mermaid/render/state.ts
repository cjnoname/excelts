/**
 * A state diagram, expressed as a flowchart.
 *
 * Structurally the two are the same picture: states are nodes, transitions are edges, and
 * a composite state is a group. Converting rather than duplicating means the layout that
 * straightens a trunk and routes a back edge around the outside works here too, and there
 * is one implementation of both to keep correct.
 *
 * The conversion is where the *state* vocabulary is spent: `[*]` becomes a marker outline
 * with no label, a `<<choice>>` becomes a rhombus, and a `<<fork>>` becomes the thin bar
 * that a fork is drawn as everywhere else.
 */

import type { FlowNode, FlowShape, FlowchartDiagram, StateDiagram } from "@mermaid/types";

/** Convert a state diagram into the flowchart the layout and renderer already understand. */
export function stateToFlowchart(diagram: StateDiagram): FlowchartDiagram {
  const nodes: FlowNode[] = diagram.states.map(state => ({
    id: state.id,
    // A marker carries no text: the disc *is* the meaning, and an id like `__start0` is an
    // implementation detail that has no business being drawn.
    text: state.marker === "none" ? state.text : "",
    shape: shapeOf(state.marker, state.stereotype),
    classes: []
  }));

  return {
    kind: "flowchart",
    direction: diagram.direction,
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    nodes,
    edges: diagram.transitions.map(transition => ({
      from: transition.from,
      to: transition.to,
      stroke: "solid" as const,
      startEnd: "none" as const,
      endEnd: "arrow" as const,
      ...(transition.label === undefined ? {} : { label: transition.label }),
      minRankSpan: 1
    })),
    subgraphs: diagram.composites,
    classDefs: []
  };
}

function shapeOf(
  marker: "none" | "start" | "end",
  stereotype: "choice" | "fork" | "join" | undefined
): FlowShape {
  if (marker === "start") {
    return "stateStart";
  }
  if (marker === "end") {
    return "stateEnd";
  }
  if (stereotype === "choice") {
    return "rhombus";
  }
  if (stereotype === "fork" || stereotype === "join") {
    // A fork bar is a rectangle that has been squeezed until it reads as a line; the
    // measuring pass gives it no text, so it comes out at the minimum size.
    return "rect";
  }
  return "round";
}
