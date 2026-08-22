/**
 * `mindmap` and `gitGraph`.
 *
 * Two layouts that share nothing with the layered one and little with each other, put
 * together because each is small: a mind map is a tree laid out by subtree height, and a
 * git graph is a sequence of commits with one lane per branch.
 *
 * The mind map is laid out left-to-right on both sides of the root, which is what makes it
 * a mind map rather than an org chart: the root sits in the middle of its own material.
 */

import { relativeLuminance } from "@draw/colour";
import { measureText, widestText, wrapText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawPathCommand, DrawTextStyle } from "@draw/types";
import { backdrop, titleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT, LINE_HEIGHT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { GitGraphDiagram, MindNode, MindmapDiagram } from "@mermaid/types";

const PAD_X = 14;
const PAD_Y = 8;
const LEVEL_GAP = 46;
const SIBLING_GAP = 12;
const MAX_LABEL = 150;

/** A measured node, before it is given a position. */
interface Measured {
  readonly node: MindNode;
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly children: Measured[];
  /** Vertical space the whole subtree needs. */
  extent: number;
  x: number;
  y: number;
}

/** Draw a mind map. */
export function mindmapDrawList(
  diagram: MindmapDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  if (!diagram.root) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const root = measure(diagram.root, style, fontSize);

  // The root's children are split between the two sides so the map grows outwards, which
  // is the shape that distinguishes a mind map from a tree drawn left to right.
  const half = Math.ceil(root.children.length / 2);
  const right = root.children.slice(0, half);
  const left = root.children.slice(half);

  const rightHeight = stack(right);
  const leftHeight = stack(left);
  const rootHeight = Math.max(root.height, rightHeight, leftHeight);

  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const centreY = padding + titleHeight + rootHeight / 2;

  place(right, root.width / 2 + LEVEL_GAP, centreY - rightHeight / 2, 1);
  place(left, -root.width / 2 - LEVEL_GAP, centreY - leftHeight / 2, -1);
  root.x = 0;
  root.y = centreY - root.height / 2;

  const all = [root, ...flatten(right), ...flatten(left)];
  const minX = Math.min(...all.map(entry => entry.x - (entry === root ? entry.width / 2 : 0)));
  const maxX = Math.max(
    ...all.map(entry => (entry === root ? entry.x + entry.width / 2 : entry.x + entry.width))
  );
  const shift = padding - minX;
  for (const entry of all) {
    entry.x += shift;
  }
  root.x -= root.width / 2;

  const width = maxX - minX + padding * 2;
  const height = Math.max(...all.map(entry => entry.y + entry.height)) + padding;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // Branches before boxes, so a curve that reaches under a border is covered by it.
  for (const [side, group] of [
    [1, right],
    [-1, left]
  ] as Array<[number, Measured[]]>) {
    for (const child of group) {
      drawBranch(root, child, side, children, theme, 0);
    }
  }
  for (const [side, group] of [
    [1, right],
    [-1, left]
  ] as Array<[number, Measured[]]>) {
    for (const child of group) {
      drawSubtree(child, side, children, theme, fontSize, fontFamily, 1);
    }
  }
  children.push(...boxNodes(root, theme, fontSize, fontFamily, 0));

  return { width, height, children };
}

function measure(node: MindNode, style: DrawTextStyle, fontSize: number): Measured {
  const lines = wrapText(node.text, style, MAX_LABEL);
  const textWidth = lines.reduce((max, line) => Math.max(max, measureText(line, style)), 0);
  const round = node.shape === "circle" || node.shape === "bang";
  return {
    node,
    lines,
    width: textWidth + PAD_X * 2 + (round ? 14 : 0),
    height: lines.length * fontSize * LINE_HEIGHT + PAD_Y * 2 + (round ? 8 : 0),
    children: node.children.map(child => measure(child, style, fontSize)),
    extent: 0,
    x: 0,
    y: 0
  };
}

/** Work out how much vertical room each subtree needs, and return the total. */
function stack(nodes: readonly Measured[]): number {
  let total = 0;
  for (const node of nodes) {
    const childExtent = stack(node.children);
    node.extent = Math.max(node.height, childExtent);
    total += node.extent + SIBLING_GAP;
  }
  return Math.max(0, total - SIBLING_GAP);
}

/** Give each node a position, centring a parent against its own children. */
function place(nodes: readonly Measured[], x: number, top: number, direction: number): void {
  let cursor = top;
  for (const node of nodes) {
    node.y = cursor + (node.extent - node.height) / 2;
    node.x = direction > 0 ? x : x - node.width;
    const childX = direction > 0 ? node.x + node.width + LEVEL_GAP : node.x - LEVEL_GAP;
    place(node.children, childX, cursor + (node.extent - stack(node.children)) / 2, direction);
    cursor += node.extent + SIBLING_GAP;
  }
}

function flatten(nodes: readonly Measured[]): Measured[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}

function drawSubtree(
  node: Measured,
  direction: number,
  out: DrawNode[],
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  depth: number
): void {
  for (const child of node.children) {
    drawBranch(node, child, direction, out, theme, depth);
  }
  out.push(...boxNodes(node, theme, fontSize, fontFamily, depth));
  for (const child of node.children) {
    drawSubtree(child, direction, out, theme, fontSize, fontFamily, depth + 1);
  }
}

/** A curve from a parent's side to a child's, which reads as a branch rather than a wire. */
function drawBranch(
  parent: Measured,
  child: Measured,
  direction: number,
  out: DrawNode[],
  theme: Theme,
  depth: number
): void {
  const from = {
    x: direction > 0 ? parent.x + parent.width : parent.x,
    y: parent.y + parent.height / 2
  };
  const to = { x: direction > 0 ? child.x : child.x + child.width, y: child.y + child.height / 2 };
  const reach = Math.abs(to.x - from.x) * 0.55;
  const commands: DrawPathCommand[] = [
    { op: "move", x: from.x, y: from.y },
    {
      op: "cubic",
      x1: from.x + reach * direction,
      y1: from.y,
      x2: to.x - reach * direction,
      y2: to.y,
      x: to.x,
      y: to.y
    }
  ];
  out.push({
    kind: "path",
    commands,
    paint: {
      stroke: theme.palette[depth % theme.palette.length],
      strokeWidth: Math.max(1.2, 3 - depth * 0.6),
      lineCap: "round"
    }
  });
}

/** One node's outline and label. */
function boxNodes(
  node: Measured,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  depth: number
): DrawNode[] {
  const colour = theme.palette[depth % theme.palette.length];
  const paint: DrawPaint = {
    fill: { ...colour, a: depth === 0 ? 1 : 0.16 },
    stroke: colour,
    strokeWidth: 1.6
  };
  const { x, y, width: w, height: h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;

  const outline: DrawNode[] = [];
  switch (node.node.shape) {
    case "circle":
    case "bang":
      outline.push({ kind: "ellipse", cx, cy, rx: w / 2, ry: h / 2, paint });
      break;
    case "square":
      outline.push({ kind: "rect", x, y, width: w, height: h, paint });
      break;
    case "hexagon": {
      const cut = Math.min(16, w / 4);
      outline.push({
        kind: "polyline",
        closed: true,
        points: [
          { x: x + cut, y },
          { x: x + w - cut, y },
          { x: x + w, y: cy },
          { x: x + w - cut, y: y + h },
          { x: x + cut, y: y + h },
          { x, y: cy }
        ],
        paint
      });
      break;
    }
    case "cloud":
      outline.push({ kind: "rect", x, y, width: w, height: h, rx: h / 2, paint });
      break;
    default:
      outline.push({ kind: "rect", x, y, width: w, height: h, rx: 6, paint });
  }

  const step = fontSize * LINE_HEIGHT;
  outline.push({
    kind: "text",
    x: cx,
    y: cy - ((node.lines.length - 1) * step) / 2 + fontSize * BASELINE_SHIFT,
    lines: node.lines.map((text, index) => ({ text, dy: index * step })),
    style: {
      size: fontSize,
      family: fontFamily,
      anchor: "middle",
      ...(depth === 0 ? { bold: true, fill: theme.edgeLabelBackground } : { fill: theme.nodeText })
    }
  });
  return outline;
}

const COMMIT_GAP = 58;
const LANE_GAP = 46;

/** Draw a git graph: one lane per branch, commits in the order they were written. */
export function gitGraphDrawList(
  diagram: GitGraphDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  if (diagram.commits.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const laneOf = new Map(diagram.branches.map((name, index) => [name, index]));
  /**
   * The colour a lane is drawn in.
   *
   * Skips palette entries too pale to read as a line. Mermaid's first entry is a near-white
   * lilac — fine as a box fill, invisible as a two-unit stroke on a white page — so `main`
   * came out as a faint smudge with its own name barely legible.
   */
  // Filtered once rather than per lane: the predicate depends only on the theme, and this is
  // called for every branch and every commit.
  const solid = theme.palette.filter(colour => relativeLuminance(colour) < 0.82);
  const usable = solid.length > 0 ? solid : theme.palette;
  const laneColour = (index: number): (typeof theme.palette)[number] =>
    usable[index % usable.length];
  const labelWidth = widestText(diagram.branches, style) + 24;
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;

  const left = padding + labelWidth;
  const top = padding + titleHeight + 14;
  const x = (index: number): number => left + index * COMMIT_GAP + COMMIT_GAP / 2;
  const y = (branch: string): number => top + (laneOf.get(branch) ?? 0) * LANE_GAP;

  const width = left + diagram.commits.length * COMMIT_GAP + padding;
  const height = top + diagram.branches.length * LANE_GAP + padding + fontSize;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // A lane starts where its branch does. Running every lane the full width made a branch
  // look as though it had existed since the first commit, which is a history the source did
  // not describe.
  const firstOn = new Map<string, number>();
  diagram.commits.forEach((commit, index) => {
    if (!firstOn.has(commit.branch)) {
      firstOn.set(commit.branch, index);
    }
  });

  // Lane rules and their names.
  diagram.branches.forEach((name, index) => {
    const laneY = top + index * LANE_GAP;
    const from = firstOn.get(name);
    const startX = index === 0 || from === undefined ? left : x(from) - COMMIT_GAP * 0.5;
    children.push({
      kind: "polyline",
      points: [
        { x: startX, y: laneY },
        { x: width - padding, y: laneY }
      ],
      paint: { stroke: laneColour(index), strokeWidth: 2 }
    });
    // The fork: a curve from the lane above down to where this branch begins.
    if (index > 0 && from !== undefined) {
      children.push({
        kind: "path",
        commands: [
          { op: "move", x: startX, y: top + (index - 1) * LANE_GAP },
          {
            op: "cubic",
            x1: startX + COMMIT_GAP * 0.35,
            y1: top + (index - 1) * LANE_GAP,
            x2: startX,
            y2: laneY,
            x: startX + COMMIT_GAP * 0.5,
            y: laneY
          }
        ],
        paint: {
          stroke: laneColour(index),
          strokeWidth: 2,
          lineCap: "round"
        }
      });
    }
    children.push({
      kind: "text",
      x: left - 12,
      y: laneY + fontSize * BASELINE_SHIFT,
      lines: [{ text: name, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "end",
        bold: true,
        fill: laneColour(index)
      }
    });
  });

  // Merge arcs before the dots, so a dot caps its own arc.
  const lastOn = new Map<string, number>();
  diagram.commits.forEach((commit, index) => {
    if (commit.kind === "merge" && commit.from !== undefined) {
      const source = lastOn.get(commit.from);
      if (source !== undefined) {
        children.push({
          kind: "path",
          commands: [
            { op: "move", x: x(source), y: y(commit.from) },
            {
              op: "cubic",
              x1: x(source) + COMMIT_GAP * 0.7,
              y1: y(commit.from),
              x2: x(index) - COMMIT_GAP * 0.7,
              y2: y(commit.branch),
              x: x(index),
              y: y(commit.branch)
            }
          ],
          paint: {
            stroke: laneColour(laneOf.get(commit.from) ?? 0),
            strokeWidth: 2,
            lineCap: "round"
          }
        });
      }
    }
    lastOn.set(commit.branch, index);
  });

  diagram.commits.forEach((commit, index) => {
    const cx = x(index);
    const cy = y(commit.branch);
    const colour = laneColour(laneOf.get(commit.branch) ?? 0);
    const radius = commit.kind === "merge" ? 9 : commit.highlight ? 10 : 7;
    children.push({
      kind: "ellipse",
      cx,
      cy,
      rx: radius,
      ry: radius,
      paint: {
        // A reverted commit is hollow, a highlighted one is ringed: both stay legible in
        // one colour, which a lane already spends.
        fill: commit.reverse ? theme.edgeLabelBackground : colour,
        stroke: commit.highlight ? theme.nodeText : theme.edgeLabelBackground,
        strokeWidth: commit.highlight ? 2.5 : 2
      }
    });
    if (commit.kind === "merge") {
      children.push({
        kind: "ellipse",
        cx,
        cy,
        rx: 3.5,
        ry: 3.5,
        paint: { fill: theme.edgeLabelBackground }
      });
    }
    // An explicit id is the only handle the source gave this commit; dropping it left an
    // anonymous dot. Auto-generated ids are not drawn — they name nothing the author wrote.
    if (!/^(c|merge-)\d+$/.test(commit.id)) {
      children.push({
        kind: "text",
        x: cx,
        y: cy + radius + fontSize,
        lines: [{ text: commit.id, dy: 0 }],
        style: {
          size: fontSize - 3,
          family: fontFamily,
          anchor: "middle",
          fill: theme.edgeText
        }
      });
    }
    if (commit.tag !== undefined) {
      const tagWidth = measureText(commit.tag, { size: fontSize - 3, family: fontFamily }) + 12;
      children.push({
        kind: "rect",
        x: cx - tagWidth / 2,
        y: cy - radius - 20,
        width: tagWidth,
        height: 15,
        rx: 3,
        paint: { fill: theme.groupFill, stroke: theme.groupStroke, strokeWidth: 1 }
      });
      children.push({
        kind: "text",
        x: cx,
        y: cy - radius - 20 + 7.5 + (fontSize - 3) * BASELINE_SHIFT,
        lines: [{ text: commit.tag, dy: 0 }],
        style: {
          size: fontSize - 3,
          family: fontFamily,
          anchor: "middle",
          fill: theme.nodeText
        }
      });
    }
  });

  return { width, height, children };
}
