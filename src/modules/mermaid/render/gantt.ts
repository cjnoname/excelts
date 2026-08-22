/**
 * A Gantt chart: bars on a time axis, grouped into sections.
 *
 * Nothing here goes through the layered layout — a Gantt bar's position is decided by the
 * calendar, not by a graph — so this is a layout and a renderer in one pass, which is
 * honest about how little there is to lay out. What it does share is the theme and the
 * primitives, and the axis arithmetic lives in `parse/dates` where it can be tested on its
 * own rather than through a picture.
 */

import { measureText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawTextStyle } from "@draw/types";
import { axisTicks, formatAxisDate } from "@mermaid/parse/dates";
import { backdrop, titleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { GanttDiagram, GanttTask, TaskState } from "@mermaid/types";

const ROW_HEIGHT = 30;
const BAR_HEIGHT = 18;
const SECTION_GAP = 8;
/** Least width the plot may shrink to, whatever the labels claim. */
const MIN_PLOT = 320;

/** Draw a Gantt chart. */
export function ganttDrawList(
  diagram: GanttDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const axisSize = fontSize - 3;

  const rows = orderedTasks(diagram);
  if (rows.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const from = Math.min(...rows.map(row => row.task.start));
  const to = Math.max(...rows.map(row => row.task.end));
  const span = Math.max(1, to - from);

  const labelWidth = Math.max(...rows.map(row => measureText(row.task.label, style)), 60) + 20;
  const sectionWidth = diagram.sections.some(name => name !== "")
    ? Math.max(...diagram.sections.map(name => measureText(name, style)), 0) + 22
    : 0;

  const plotWidth = Math.max(MIN_PLOT, span / 86_400_000 > 60 ? 620 : 460);
  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const axisHeight = fontSize * 2;
  const plotLeft = padding + sectionWidth + labelWidth;
  const plotTop = padding + titleHeight + axisHeight;

  const height = plotTop + rows[rows.length - 1].y + ROW_HEIGHT + SECTION_GAP + padding;
  const width = plotLeft + plotWidth + padding;
  const at = (time: number): number => plotLeft + ((time - from) / span) * plotWidth;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  // Gridlines first, so every bar and label sits over them.
  const ticks = axisTicks(from, to, Math.max(3, Math.floor(plotWidth / 78)));
  for (const tick of ticks) {
    const x = at(tick);
    children.push({
      kind: "polyline",
      points: [
        { x, y: plotTop - 6 },
        { x, y: height - padding }
      ],
      paint: { stroke: theme.groupStroke, strokeWidth: 0.8, dash: [3, 3] }
    });
    children.push({
      kind: "text",
      x,
      y: plotTop - 12,
      lines: [{ text: formatAxisDate(tick, span), dy: 0 }],
      style: {
        size: axisSize,
        family: fontFamily,
        anchor: "middle",
        fill: theme.edgeText
      }
    });
  }

  // Section bands, so a reader can tell which rows belong together at a glance.
  let bandIndex = 0;
  for (const name of diagram.sections) {
    const members = rows.filter(row => row.task.section === name);
    if (members.length === 0) {
      continue;
    }
    const top = plotTop + members[0].y - 3;
    const bottom = plotTop + members[members.length - 1].y + ROW_HEIGHT - 3;
    if (bandIndex % 2 === 0) {
      children.push({
        kind: "rect",
        x: padding,
        y: top,
        width: width - padding * 2,
        height: bottom - top,
        paint: { fill: theme.groupFill }
      });
    }
    if (name !== "") {
      children.push({
        kind: "text",
        x: padding + 6,
        y: (top + bottom) / 2 + fontSize * BASELINE_SHIFT,
        lines: [{ text: name, dy: 0 }],
        style: {
          size: fontSize,
          family: fontFamily,
          anchor: "start",
          bold: true,
          fill: theme.nodeText
        }
      });
    }
    bandIndex++;
  }

  for (const row of rows) {
    const y = plotTop + row.y;
    children.push({
      kind: "text",
      x: plotLeft - 10,
      y: y + ROW_HEIGHT / 2 + fontSize * BASELINE_SHIFT,
      lines: [{ text: row.task.label, dy: 0 }],
      style: { size: fontSize, family: fontFamily, anchor: "end", fill: theme.nodeText }
    });

    const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    if (row.task.milestone) {
      // A diamond, because a milestone is an instant and a bar would imply a span.
      const cx = at(row.task.start);
      const cy = barY + BAR_HEIGHT / 2;
      const r = BAR_HEIGHT / 2;
      children.push({
        kind: "polyline",
        closed: true,
        points: [
          { x: cx, y: cy - r },
          { x: cx + r, y: cy },
          { x: cx, y: cy + r },
          { x: cx - r, y: cy }
        ],
        paint: barPaint(row.task.state, theme)
      });
      continue;
    }

    const left = at(row.task.start);
    // A zero-length bar would vanish; a task that takes no time is still a task.
    const barWidth = Math.max(3, at(row.task.end) - left);
    children.push({
      kind: "rect",
      x: left,
      y: barY,
      width: barWidth,
      height: BAR_HEIGHT,
      rx: 3,
      paint: barPaint(row.task.state, theme)
    });
  }

  return { width, height, children };
}

/** Tasks in section order, each with the row it occupies. */
function orderedTasks(diagram: GanttDiagram): Array<{ task: GanttTask; y: number }> {
  const rows: Array<{ task: GanttTask; y: number }> = [];
  let y = 0;
  for (const section of diagram.sections) {
    const members = diagram.tasks.filter(task => task.section === section);
    for (const task of members) {
      rows.push({ task, y });
      y += ROW_HEIGHT;
    }
    if (members.length > 0) {
      y += SECTION_GAP;
    }
  }
  // A task in no declared section still has to appear.
  for (const task of diagram.tasks) {
    if (!diagram.sections.includes(task.section)) {
      rows.push({ task, y });
      y += ROW_HEIGHT;
    }
  }
  return rows;
}

/**
 * The fill for a bar.
 *
 * The four states say different things and are drawn differently: `crit` is the one a
 * reader must not miss, `done` recedes, `active` is picked out of the default.
 */
function barPaint(state: TaskState, theme: Theme): DrawPaint {
  const palette = theme.palette;
  switch (state) {
    case "crit":
      return { fill: palette[1], stroke: palette[1], strokeWidth: 1 };
    case "done":
      return { fill: { ...theme.nodeStroke, a: 0.35 }, stroke: theme.nodeStroke, strokeWidth: 1 };
    case "active":
      return { fill: palette[2], stroke: palette[2], strokeWidth: 1 };
    default:
      return { fill: palette[0], stroke: palette[0], strokeWidth: 1 };
  }
}
