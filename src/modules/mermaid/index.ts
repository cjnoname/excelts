/**
 * `mermaid` — Mermaid diagram text to a drawable display list.
 *
 * The module is a *producer*: it turns a diagram into a {@link DrawList} and stops there.
 * Nothing here knows what SVG or a PDF page is, and that is what lets one implementation
 * serve every output — `documonster/draw` renders the list to markup or pixels, and
 * `documonster/pdf` renders it onto a page.
 *
 * @example
 * ```ts
 * import { mermaidToSvg } from "documonster/mermaid";
 *
 * Twenty-one diagram types are drawn: `flowchart`, `stateDiagram`, `classDiagram`,
 * `erDiagram`, `sequenceDiagram`, `requirementDiagram`, `C4`, `architecture`, `gantt`,
 * `timeline`, `journey`, `kanban`, `mindmap`, `gitGraph`, `quadrantChart`, `xychart`,
 * `radar`, `sankey`, `packet`, `block` and `pie`.
 *
 * const svg = mermaidToSvg(`flowchart TD
 *   A[Start] --> B{Ready?}
 *   B -->|yes| C[Ship it]
 *   B -->|no| A`);
 * ```
 *
 * @example Any backend, from the same list.
 * ```ts
 * import { mermaidToDrawList } from "documonster/mermaid";
 * import { rasterizeToRgba, toSvg } from "documonster/draw";
 *
 * const list = mermaidToDrawList("pie title Split\n \"A\" : 60\n \"B\" : 40");
 * const svg = toSvg(list);
 * const pixels = rasterizeToRgba(list, { scale: 2 });
 * ```
 */

import { toSvg } from "@draw/svg";
import type { DrawList, DrawNode } from "@draw/types";
import { layoutFlowchart } from "@mermaid/layout/flowchart";
import type { FlowLayout, LayoutOptions } from "@mermaid/layout/flowchart";
import { MermaidSyntaxError, parseMermaid } from "@mermaid/parse/index";
import {
  architectureNodes,
  architectureToFlowchart,
  kanbanDrawList,
  packetDrawList,
  radarDrawList
} from "@mermaid/render/beta";
import { quadrantDrawList, sankeyDrawList, xyDrawList } from "@mermaid/render/chart";
import { classDiagramNodes, classNodeSizer, classToFlowchart } from "@mermaid/render/class";
import { erDiagramNodes, erNodeSizer, erToFlowchart } from "@mermaid/render/er";
import { flowchartNodes } from "@mermaid/render/flowchart";
import { ganttDrawList } from "@mermaid/render/gantt";
import {
  blockDrawList,
  c4DiagramNodes,
  c4NodeSizer,
  c4ToFlowchart,
  requirementDiagramNodes,
  requirementNodeSizer,
  requirementToFlowchart
} from "@mermaid/render/model";
import { backdrop } from "@mermaid/render/shared";
import { pieDrawList, sequenceDrawList } from "@mermaid/render/simple";
import { stateToFlowchart } from "@mermaid/render/state";
import { journeyDrawList, timelineDrawList } from "@mermaid/render/track";
import { gitGraphDrawList, mindmapDrawList } from "@mermaid/render/tree";
import { resolveTheme } from "@mermaid/theme";
import type { Theme, ThemeOptions } from "@mermaid/theme";
import type { MermaidDiagram } from "@mermaid/types";

/** How to draw a diagram. */
export interface MermaidRenderOptions extends LayoutOptions {
  /** Colour overrides; anything omitted keeps the default theme. */
  readonly theme?: ThemeOptions;
  /**
   * Background fill. `"transparent"` — the default — leaves the list without a backdrop,
   * so a caller compositing the diagram onto something else gets what they asked for.
   */
  readonly background?: string;
}

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_FAMILY = "Arial";
const DEFAULT_PADDING = 16;

/**
 * Wrap a laid-out diagram's nodes into a display list.
 *
 * Five diagram types reached this same four-step shape — take the layout's size, put the
 * background down first if one was asked for, then the nodes — and a shape repeated five
 * times is four chances for one of them to forget the background or report the wrong size.
 */
function fromLayout(layout: FlowLayout, theme: Theme, nodes: readonly DrawNode[]): DrawList {
  return {
    width: layout.width,
    height: layout.height,
    // Background first: several callers depend on reading it as the list's opening node.
    children: [...backdrop(theme, layout.width, layout.height), ...nodes]
  };
}

/**
 * Draw a diagram, from source or from an already-parsed tree.
 *
 * @throws {MermaidSyntaxError} when a string names no supported diagram.
 */
export function mermaidToDrawList(
  source: string | MermaidDiagram,
  options: MermaidRenderOptions = {}
): DrawList {
  const diagram = typeof source === "string" ? parseMermaid(source) : source;
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const padding = options.padding ?? DEFAULT_PADDING;
  const theme = resolveTheme({
    ...options.theme,
    ...(options.background === undefined ? {} : { background: options.background })
  });

  if (diagram.kind === "pie") {
    return pieDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "gantt") {
    return ganttDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "timeline") {
    return timelineDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "journey") {
    return journeyDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "mindmap") {
    return mindmapDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "git") {
    return gitGraphDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "quadrant") {
    return quadrantDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "xy") {
    return xyDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "sankey") {
    return sankeyDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "packet") {
    return packetDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "kanban") {
    return kanbanDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "radar") {
    return radarDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "architecture") {
    const archLayout = layoutFlowchart(architectureToFlowchart(diagram), options);
    return fromLayout(
      archLayout,
      theme,
      architectureNodes(archLayout, theme, fontSize, fontFamily)
    );
  }
  if (diagram.kind === "block") {
    return blockDrawList(diagram, theme, fontSize, fontFamily, padding);
  }
  if (diagram.kind === "requirement" || diagram.kind === "c4") {
    // Both are graphs of boxes that size themselves, so the shared layout does the hard
    // part and only the box design differs.
    const flow =
      diagram.kind === "requirement" ? requirementToFlowchart(diagram) : c4ToFlowchart(diagram);
    const sizer =
      diagram.kind === "requirement"
        ? requirementNodeSizer(diagram, fontSize, fontFamily)
        : c4NodeSizer(diagram, fontSize, fontFamily);
    const modelLayout = layoutFlowchart(flow, { ...options, measureNode: sizer });
    return fromLayout(
      modelLayout,
      theme,
      diagram.kind === "requirement"
        ? requirementDiagramNodes(diagram, modelLayout, theme, fontSize, fontFamily)
        : c4DiagramNodes(diagram, modelLayout, theme, fontSize, fontFamily)
    );
  }
  if (diagram.kind === "sequence") {
    return sequenceDrawList(diagram, theme, fontSize, fontFamily, padding);
  }

  // A class diagram sizes its own boxes — a compartment stack is not a centred label — but
  // everything difficult about a layout is shared.
  if (diagram.kind === "class") {
    const layout = layoutFlowchart(classToFlowchart(diagram), {
      ...options,
      measureNode: classNodeSizer(diagram, fontSize, fontFamily)
    });
    return fromLayout(
      layout,
      theme,
      classDiagramNodes(diagram, layout, theme, fontSize, fontFamily)
    );
  }

  if (diagram.kind === "er") {
    const layout = layoutFlowchart(erToFlowchart(diagram), {
      ...options,
      measureNode: erNodeSizer(diagram, fontSize, fontFamily)
    });
    return fromLayout(layout, theme, erDiagramNodes(diagram, layout, theme, fontSize, fontFamily));
  }

  // A state diagram is the same picture in a different language; converting it here means
  // one layout and one renderer serve both.
  const flow = diagram.kind === "state" ? stateToFlowchart(diagram) : diagram;
  const layout = layoutFlowchart(flow, options);
  return fromLayout(
    layout,
    theme,
    flowchartNodes(layout, theme, flow.classDefs, fontSize, fontFamily)
  );
}

/**
 * Draw a diagram as SVG.
 *
 * A convenience over {@link mermaidToDrawList} and `toSvg`; a caller that wants pixels or
 * a PDF page passes the list to the matching backend instead.
 *
 * @throws {MermaidSyntaxError} when the source names no supported diagram.
 */
export function mermaidToSvg(
  source: string | MermaidDiagram,
  options: MermaidRenderOptions = {}
): string {
  const list = mermaidToDrawList(source, options);
  return toSvg(list, {
    ...(options.background === undefined || options.background === "transparent"
      ? {}
      : { background: options.background })
  });
}

export { MermaidSyntaxError, parseMermaid };
export { layoutFlowchart };
export type { LayoutOptions, ThemeOptions };
export type { EdgeRoute, FlowLayout, GroupBox, NodeBox } from "@mermaid/layout/flowchart";
export type { Theme } from "@mermaid/theme";
export type {
  ClassBox,
  ClassDef,
  ClassDiagram,
  ClassLink,
  ClassMember,
  ClassRelation,
  Cardinality,
  EdgeEnd,
  Entity,
  EntityAttribute,
  EntityRelation,
  ErDiagram,
  GanttDiagram,
  GanttTask,
  JourneyDiagram,
  JourneyTask,
  GitCommit,
  GitGraphDiagram,
  MindNode,
  MindShape,
  MindmapDiagram,
  ArchitectureDiagram,
  ArchitectureEdge,
  ArchitectureNode,
  BlockCell,
  BlockDiagram,
  C4Boundary,
  C4Diagram,
  C4Element,
  C4Relation,
  KanbanCard,
  KanbanColumn,
  KanbanDiagram,
  PacketDiagram,
  PacketField,
  QuadrantDiagram,
  QuadrantPoint,
  SankeyDiagram,
  RadarDiagram,
  RadarSeries,
  Requirement,
  RequirementDiagram,
  RequirementElement,
  RequirementLink,
  SankeyLink,
  XyDiagram,
  XySeries,
  TimelineDiagram,
  TimelinePeriod,
  EdgeStroke,
  FlowDirection,
  FlowEdge,
  FlowNode,
  FlowShape,
  FlowSubgraph,
  FlowchartDiagram,
  MermaidDiagram,
  PieDiagram,
  StateDiagram,
  StateNode,
  StateTransition,
  TaskState,
  Visibility,
  PieSlice,
  SequenceDiagram,
  SequenceLine,
  SequenceMessage,
  SequenceParticipant,
  // `SequenceDiagram.body` is part of the public surface, so the types naming its elements
  // have to be too: without these a caller can read `diagram.body` but cannot declare a
  // variable to hold one of its entries.
  SequenceBlock,
  SequenceEntry,
  SequenceMessageEntry,
  SequenceNote,
  SequenceSection,
  NotePlacement
} from "@mermaid/types";
