/**
 * `pie` and `sequenceDiagram` → {@link DrawList}.
 *
 * Both are simple enough that layout and paint are one pass: a pie's geometry is decided
 * by its own angles, and a sequence diagram is a grid. Keeping them here rather than
 * splitting each into a layout and a render module would be false symmetry with the
 * flowchart, whose layout is a real algorithm with its own tests.
 */

import { measureText, wrapText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawPoint, DrawTextStyle } from "@draw/types";
import {
  arrowHead as sharedArrowHead,
  backdrop,
  formatTick,
  legendEntry,
  titleBlock
} from "@mermaid/render/shared";
import { BASELINE_SHIFT, LINE_HEIGHT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type {
  PieDiagram,
  SequenceDiagram,
  SequenceEntry,
  SequenceMessage,
  SequenceNote
} from "@mermaid/types";

/** Draw a pie chart. */
/**
 * How wide a message label may run before it wraps.
 *
 * One definition, because two passes depend on it agreeing with itself: `planBody` wraps to
 * this width to decide how tall a message row has to be, and `label` wraps to it again to
 * decide what to actually draw. A row sized for two lines that then draws three grows up into
 * whatever sits above it, which is the bug the row height was introduced to prevent.
 */
const MESSAGE_WRAP = 260;

export function pieDrawList(
  diagram: PieDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const slices = diagram.slices.filter(slice => Number.isFinite(slice.value) && slice.value > 0);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  const legendWidth =
    slices.reduce(
      (max, slice) =>
        Math.max(
          max,
          measureText(legendLabel(slice.label, slice.value, total, diagram.showData), style)
        ),
      0
    ) + 34;
  const titleHeight = diagram.title ? fontSize * 2.2 : 0;
  const diameter = 240;
  const width = padding * 2 + diameter + 28 + legendWidth;
  const height = padding * 2 + titleHeight + Math.max(diameter, slices.length * fontSize * 1.9);

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  const cx = padding + diameter / 2;
  const cy = padding + titleHeight + diameter / 2;
  const radius = diameter / 2;

  // Start at twelve o'clock and run clockwise, which is how a reader expects to be led
  // through the slices and what Mermaid does.
  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
    const colour = theme.palette[index % theme.palette.length];
    children.push({
      kind: "sector",
      cx,
      cy,
      radius,
      innerRadius: 0,
      startAngle: angle,
      endAngle: angle + sweep,
      paint: { fill: colour, stroke: theme.edgeLabelBackground, strokeWidth: 1.5 }
    });
    // A share only reads as a number when it is written down; below 5% there is no room.
    if (sweep > 0.32) {
      const mid = angle + sweep / 2;
      const at = radius * 0.62;
      children.push({
        kind: "text",
        x: cx + Math.cos(mid) * at,
        y: cy + Math.sin(mid) * at + fontSize * BASELINE_SHIFT,
        lines: [{ text: `${Math.round((slice.value / total) * 100)}%`, dy: 0 }],
        style: {
          size: fontSize - 1,
          family: fontFamily,
          anchor: "middle",
          fill: theme.paletteText(colour)
        }
      });
    }
    angle += sweep;
  });

  const legendX = padding + diameter + 28;
  let legendY = padding + titleHeight + 6;
  slices.forEach((slice, index) => {
    children.push(
      ...legendEntry(
        legendX,
        legendY,
        theme.palette[index % theme.palette.length],
        legendLabel(slice.label, slice.value, total, diagram.showData),
        fontSize,
        fontFamily,
        theme
      )
    );
    legendY += fontSize * 1.9;
  });

  return { width, height, children };
}

function legendLabel(label: string, value: number, total: number, showData: boolean): string {
  if (!showData) {
    return label;
  }
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return `${label} — ${formatTick(value)} (${share}%)`;
}

/**
 * Draw a sequence diagram.
 *
 * Two passes over the body. The first walks the tree and assigns every message, note and
 * frame a row, because a frame's height is decided by what it contains and cannot be known
 * until its contents have been placed. The second draws.
 */
export function sequenceDrawList(
  diagram: SequenceDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const messageStyle: DrawTextStyle = { size: fontSize - 1, family: fontFamily };
  const participants = diagram.participants;
  if (participants.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const index = new Map(participants.map((participant, i) => [participant.id, i]));
  const boxWidths = participants.map(p => Math.max(90, measureText(p.text, style) + 28));

  const gaps = participants.map((_, i) => {
    // A lane must be wide enough for the widest message written across it, or the text
    // spills over the neighbouring lifeline and stops meaning anything.
    const spanning = diagram.messages.filter(message => {
      const from = index.get(message.from) ?? -1;
      const to = index.get(message.to) ?? -1;
      return Math.min(from, to) <= i && Math.max(from, to) > i;
    });
    const widest = spanning.reduce((max, m) => Math.max(max, measureText(m.text, messageStyle)), 0);
    return Math.max(70, widest + 24);
  });

  const centres: number[] = [];
  let cursor = padding + BLOCK_INSET;
  participants.forEach((_, i) => {
    centres.push(cursor + boxWidths[i] / 2);
    cursor += boxWidths[i] + (i < participants.length - 1 ? gaps[i] : 0);
  });

  const titleHeight = diagram.title ? fontSize * 2.2 : 0;
  const headerTop = padding + titleHeight;
  const headerHeight = fontSize * 2.4;

  // Pass one: rows.
  const plan = planBody(diagram.body, headerTop + headerHeight + fontSize * 1.6, {
    fontSize,
    messageStyle,
    maxLabelWidth: MESSAGE_WRAP
  });

  const bottom = plan.bottom + fontSize * 1.4;
  const width = cursor + BLOCK_INSET + padding;
  const height = bottom + headerHeight + padding;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // Lifelines first, so every box, frame and arrow sits over them.
  participants.forEach((_, i) => {
    children.push({
      kind: "polyline",
      points: [
        { x: centres[i], y: headerTop + headerHeight },
        { x: centres[i], y: bottom }
      ],
      paint: { stroke: theme.nodeStroke, strokeWidth: 1.2, dash: [4, 4] }
    });
  });

  const boxPaint: DrawPaint = { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.5 };
  const drawHeader = (top: number): void => {
    participants.forEach((participant, i) => {
      if (participant.actor) {
        // `actor` asks for a person, and drawing it as a box made the distinction the author
        // spelled out invisible. A stick figure from the primitives every backend has: head,
        // body, arms, legs.
        const cx = centres[i];
        const head = top + headerHeight * 0.28;
        const r = headerHeight * 0.17;
        const stick: DrawPaint = { stroke: theme.nodeStroke, strokeWidth: 1.6, lineCap: "round" };
        children.push({ kind: "ellipse", cx, cy: head, rx: r, ry: r, paint: stick });
        children.push({
          kind: "polyline",
          points: [
            { x: cx, y: head + r },
            { x: cx, y: top + headerHeight * 0.72 }
          ],
          paint: stick
        });
        children.push({
          kind: "polyline",
          points: [
            { x: cx - r * 1.4, y: head + r * 1.5 },
            { x: cx + r * 1.4, y: head + r * 1.5 }
          ],
          paint: stick
        });
        for (const side of [-1, 1]) {
          children.push({
            kind: "polyline",
            points: [
              { x: cx, y: top + headerHeight * 0.72 },
              { x: cx + side * r * 1.2, y: top + headerHeight }
            ],
            paint: stick
          });
        }
        children.push({
          kind: "text",
          x: cx,
          y: top + headerHeight + fontSize,
          lines: [{ text: participant.text, dy: 0 }],
          style: { size: fontSize, family: fontFamily, anchor: "middle", fill: theme.nodeText }
        });
        return;
      }
      children.push({
        kind: "rect",
        x: centres[i] - boxWidths[i] / 2,
        y: top,
        width: boxWidths[i],
        height: headerHeight,
        rx: 4,
        paint: boxPaint
      });
      children.push({
        kind: "text",
        x: centres[i],
        y: top + headerHeight / 2 + fontSize * BASELINE_SHIFT,
        lines: [{ text: participant.text, dy: 0 }],
        style: { size: fontSize, family: fontFamily, anchor: "middle", fill: theme.nodeText }
      });
    });
  };
  // Repeated at the foot, as Mermaid does: a long exchange is unreadable if the reader has
  // to scroll back to learn which lifeline is which.
  drawHeader(headerTop);
  drawHeader(bottom);

  // Activation bars, from each activating message to the one that ends it. Drawn before the
  // messages so an arrowhead lands on top of the bar rather than under it.
  const bars: DrawNode[] = [];
  const openAt = new Map<string, number>();
  const walk = (list: readonly PlacedEntry[]): void => {
    for (const entry of list) {
      if (entry.kind === "block") {
        for (const section of entry.sections) {
          walk(section.entries);
        }
        continue;
      }
      if (entry.kind !== "message") {
        continue;
      }
      if (entry.message.activates === true) {
        openAt.set(entry.message.to, entry.y);
      }
      if (entry.message.deactivates === true) {
        const from = openAt.get(entry.message.from);
        const lane = index.get(entry.message.from);
        if (from !== undefined && lane !== undefined) {
          bars.push({
            kind: "rect",
            x: centres[lane] - 5,
            y: from,
            width: 10,
            height: Math.max(6, entry.y - from),
            paint: { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.2 }
          });
        }
        openAt.delete(entry.message.from);
      }
    }
  };
  walk(plan.entries);
  // An activation nobody closed runs to the foot, which is what Mermaid does.
  for (const [id, from] of openAt) {
    const lane = index.get(id);
    if (lane !== undefined) {
      bars.push({
        kind: "rect",
        x: centres[lane] - 5,
        y: from,
        width: 10,
        height: Math.max(6, bottom - from),
        paint: { fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.2 }
      });
    }
  }
  children.push(...bars);

  const context: DrawContext = {
    theme,
    fontSize,
    fontFamily,
    messageStyle,
    centres,
    index,
    span: { left: padding, right: width - padding },
    autonumber: diagram.autonumber ? { next: 1 } : undefined
  };
  drawEntries(plan.entries, children, context);

  return { width, height, children };
}

/** Room reserved on each side of the lifelines for a frame's own border. */
const BLOCK_INSET = 14;
/** Height of the tab a frame's keyword sits in. */
const BLOCK_TAB_HEIGHT = 18;

/** A placed entry: the tree, with a row on every node. */
type PlacedEntry =
  | { kind: "message"; message: SequenceMessage; y: number; height: number }
  | { kind: "note"; note: SequenceNote; y: number; height: number; lines: string[] }
  | {
      kind: "block";
      keyword: string;
      y: number;
      bottom: number;
      sections: Array<{ label: string; y: number; entries: PlacedEntry[] }>;
    };

interface PlanConfig {
  readonly fontSize: number;
  readonly messageStyle: DrawTextStyle;
  readonly maxLabelWidth: number;
}

/**
 * Assign a row to everything, depth first.
 *
 * A frame's height is the extent of what it holds, so its own row can only be finished
 * after its contents have been placed — which is why this returns the cursor it reached
 * rather than taking a fixed step per entry.
 */
function planBody(
  body: readonly SequenceEntry[],
  top: number,
  config: PlanConfig
): { entries: PlacedEntry[]; bottom: number } {
  const entries: PlacedEntry[] = [];
  let cursor = top;

  for (const entry of body) {
    if (entry.kind === "message") {
      // Sized from the label's own line count. A fixed row height let a wrapped label grow
      // upwards into whatever was above it — the previous message, a frame's keyword, or the
      // participant boxes themselves.
      const lines = wrapText(entry.text, config.messageStyle, config.maxLabelWidth).length;
      const height = config.fontSize * 2.4 + (lines - 1) * config.messageStyle.size * LINE_HEIGHT;
      entries.push({ kind: "message", message: entry, y: cursor + height * 0.62, height });
      cursor += height;
      continue;
    }
    if (entry.kind === "note") {
      const lines = wrapText(entry.text, config.messageStyle, config.maxLabelWidth);
      const height = lines.length * config.messageStyle.size * LINE_HEIGHT + 16;
      entries.push({ kind: "note", note: entry, y: cursor + 8, height, lines });
      cursor += height + 12;
      continue;
    }

    const blockTop = cursor;
    cursor += BLOCK_TAB_HEIGHT + 6;
    const sections: Array<{ label: string; y: number; entries: PlacedEntry[] }> = [];
    entry.sections.forEach((section, position) => {
      if (position > 0) {
        // A rule and its own label separate one branch from the next.
        cursor += config.fontSize * 1.5;
      }
      const placed = planBody(section.body, cursor, config);
      sections.push({ label: section.label, y: cursor, entries: placed.entries });
      cursor = placed.bottom;
    });
    cursor += 10;
    entries.push({ kind: "block", keyword: entry.keyword, y: blockTop, bottom: cursor, sections });
    cursor += 8;
  }

  return { entries, bottom: cursor };
}

interface DrawContext {
  readonly theme: Theme;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly messageStyle: DrawTextStyle;
  readonly centres: readonly number[];
  readonly index: ReadonlyMap<string, number>;
  readonly span: { left: number; right: number };
  /** Mutable so the counter survives the walk; `undefined` when not requested. */
  readonly autonumber?: { next: number };
}

function drawEntries(entries: readonly PlacedEntry[], out: DrawNode[], context: DrawContext): void {
  for (const entry of entries) {
    if (entry.kind === "message") {
      drawMessage(entry.message, entry.y, out, context);
    } else if (entry.kind === "note") {
      drawNote(entry, out, context);
    } else {
      drawBlock(entry, out, context);
    }
  }
}

/** A framed group, with a tab naming the keyword and a rule between sections. */
function drawBlock(
  block: Extract<PlacedEntry, { kind: "block" }>,
  out: DrawNode[],
  context: DrawContext
): void {
  const { theme, fontSize, fontFamily } = context;
  const left = context.span.left;
  const right = context.span.right;
  const framePaint: DrawPaint = { stroke: theme.nodeStroke, strokeWidth: 1.2 };

  out.push({
    kind: "rect",
    x: left,
    y: block.y,
    width: right - left,
    height: block.bottom - block.y,
    paint: framePaint
  });

  const keyword = block.keyword;
  const tabWidth = measureText(keyword, { size: fontSize - 2, family: fontFamily }) + 18;
  out.push({
    kind: "polyline",
    closed: true,
    points: [
      { x: left, y: block.y },
      { x: left + tabWidth, y: block.y },
      { x: left + tabWidth, y: block.y + BLOCK_TAB_HEIGHT - 5 },
      { x: left + tabWidth - 6, y: block.y + BLOCK_TAB_HEIGHT },
      { x: left, y: block.y + BLOCK_TAB_HEIGHT }
    ],
    paint: { fill: theme.groupFill, stroke: theme.nodeStroke, strokeWidth: 1.2 }
  });
  out.push({
    kind: "text",
    x: left + 9,
    y: block.y + BLOCK_TAB_HEIGHT / 2 + fontSize * BASELINE_SHIFT,
    lines: [{ text: keyword, dy: 0 }],
    style: {
      size: fontSize - 2,
      family: fontFamily,
      anchor: "start",
      bold: true,
      fill: theme.nodeText
    }
  });

  block.sections.forEach((section, position) => {
    if (position > 0) {
      // A dashed rule, because the branches are alternatives rather than a sequence.
      out.push({
        kind: "polyline",
        points: [
          { x: left, y: section.y - 6 },
          { x: right, y: section.y - 6 }
        ],
        paint: { stroke: theme.nodeStroke, strokeWidth: 1, dash: [5, 4] }
      });
    }
    if (section.label !== "") {
      out.push({
        kind: "text",
        x: position === 0 ? left + tabWidth + 8 : left + 8,
        y:
          (position === 0 ? block.y + BLOCK_TAB_HEIGHT / 2 : section.y + context.fontSize * 0.2) +
          fontSize * BASELINE_SHIFT,
        lines: [{ text: `[${section.label}]`, dy: 0 }],
        style: {
          size: fontSize - 2,
          family: fontFamily,
          anchor: "start",
          fill: theme.edgeText
        }
      });
    }
    drawEntries(section.entries, out, context);
  });
}

/** A note: a panel beside or across the lifelines it names. */
function drawNote(
  entry: Extract<PlacedEntry, { kind: "note" }>,
  out: DrawNode[],
  context: DrawContext
): void {
  const { theme, fontFamily, messageStyle, centres, index } = context;
  const positions = entry.note.participants
    .map(id => index.get(id))
    .filter((value): value is number => value !== undefined);
  if (positions.length === 0) {
    return;
  }
  const textWidth = entry.lines.reduce(
    (max, line) => Math.max(max, measureText(line, messageStyle)),
    0
  );

  let x: number;
  let width: number;
  if (entry.note.placement === "over" && positions.length > 1) {
    const from = centres[Math.min(...positions)];
    const to = centres[Math.max(...positions)];
    x = from - 30;
    width = Math.max(textWidth + 24, to - from + 60);
  } else {
    width = textWidth + 24;
    const centre = centres[positions[0]];
    x =
      entry.note.placement === "left"
        ? centre - width - 12
        : entry.note.placement === "right"
          ? centre + 12
          : centre - width / 2;
  }

  out.push({
    kind: "rect",
    x,
    y: entry.y,
    width,
    height: entry.height - 8,
    rx: 3,
    paint: { fill: theme.groupFill, stroke: theme.groupStroke, strokeWidth: 1 }
  });
  const step = messageStyle.size * LINE_HEIGHT;
  const first =
    entry.y +
    (entry.height - 8) / 2 -
    ((entry.lines.length - 1) * step) / 2 +
    messageStyle.size * BASELINE_SHIFT;
  out.push({
    kind: "text",
    x: x + width / 2,
    y: first,
    lines: entry.lines.map((text, i) => ({ text, dy: i * step })),
    style: {
      size: messageStyle.size,
      family: fontFamily,
      anchor: "middle",
      fill: theme.nodeText
    }
  });
}

/** One message: its line, its head, and its label. */
function drawMessage(
  message: SequenceMessage,
  y: number,
  out: DrawNode[],
  context: DrawContext
): void {
  const { theme, fontSize, fontFamily, messageStyle, centres, index } = context;
  const from = index.get(message.from);
  const to = index.get(message.to);
  if (from === undefined || to === undefined) {
    return;
  }
  const numbered =
    context.autonumber === undefined
      ? message.text
      : `${context.autonumber.next++}. ${message.text}`;
  const paint: DrawPaint = {
    stroke: theme.edge,
    strokeWidth: 1.6,
    ...(message.line === "dotted" ? { dash: [5, 4] } : {})
  };

  if (from === to) {
    // A self-call loops out and back rather than collapsing to a point.
    const x = centres[from];
    const reach = 34;
    const points: DrawPoint[] = [
      { x, y },
      { x: x + reach, y },
      { x: x + reach, y: y + fontSize },
      { x, y: y + fontSize }
    ];
    out.push({ kind: "polyline", points, paint });
    out.push(...arrowHead(points[3], points[2], theme));
    out.push(
      label(
        numbered,
        x + reach + 8,
        y + fontSize * 0.2,
        "start",
        messageStyle.size,
        fontFamily,
        theme
      )
    );
    return;
  }

  const x1 = centres[from];
  const x2 = centres[to];
  const direction = Math.sign(x2 - x1);
  const tip = { x: x2 - direction, y };
  out.push({
    kind: "polyline",
    points: [
      { x: x1, y },
      { x: tip.x - direction * (message.arrow === "arrow" ? 9 : 0), y }
    ],
    paint
  });
  if (message.arrow === "arrow") {
    out.push(...arrowHead(tip, { x: x1, y }, theme));
  } else if (message.arrow === "circle") {
    out.push({
      kind: "ellipse",
      cx: tip.x - direction * 4,
      cy: y,
      rx: 4,
      ry: 4,
      paint: { fill: theme.edgeLabelBackground, stroke: theme.edge, strokeWidth: 1.4 }
    });
  } else {
    const arm = 4.5;
    const cx = tip.x - direction * arm;
    for (const [dy1, dy2] of [
      [-arm, arm],
      [arm, -arm]
    ]) {
      out.push({
        kind: "polyline",
        points: [
          { x: cx - arm, y: y + dy1 },
          { x: cx + arm, y: y + dy2 }
        ],
        paint: { stroke: theme.edge, strokeWidth: 1.6, lineCap: "round" }
      });
    }
  }
  out.push(
    label(
      numbered,
      (x1 + x2) / 2,
      y - fontSize * 0.55,
      "middle",
      messageStyle.size,
      fontFamily,
      theme
    )
  );
}

/**
 * A sequence arrow, drawn slightly smaller than a flowchart's.
 *
 * The size stays a local constant rather than adopting the shared default: nothing establishes
 * which of the two figures is correct, so unifying them would change this diagram's output on
 * no evidence. The geometry is shared; only the numbers are ours.
 */
function arrowHead(tip: DrawPoint, towards: DrawPoint, theme: Theme): DrawNode[] {
  return sharedArrowHead(tip, towards, { fill: theme.edge }, 10, 4);
}

function label(
  text: string,
  x: number,
  y: number,
  anchor: "start" | "middle",
  size: number,
  family: string,
  theme: Theme
): DrawNode {
  const lines = wrapText(text, { size, family }, MESSAGE_WRAP);
  return {
    kind: "text",
    x,
    y: y - (lines.length - 1) * size * LINE_HEIGHT,
    lines: lines.map((line, index) => ({ text: line, dy: index * size * LINE_HEIGHT })),
    style: { size, family, anchor, fill: theme.edgeText }
  };
}
