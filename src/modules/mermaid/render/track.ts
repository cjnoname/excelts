/**
 * `timeline` and `journey`: a sequence of stops along one axis.
 *
 * Both are drawn as a spine with the stops hung off it, because that is what both are
 * *about* — the order, and what sits at each point. The difference is what a stop holds: a
 * timeline stacks the events recorded against a period, a journey plots a satisfaction
 * score, and the score is the whole reason the diagram exists, so it is drawn as a
 * position on an axis rather than written as a number.
 */

import { wrapText } from "@draw/text";
import type { DrawList, DrawNode, DrawPaint, DrawTextStyle } from "@draw/types";
import { backdrop, titleBlock } from "@mermaid/render/shared";
import { BASELINE_SHIFT, LINE_HEIGHT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { JourneyDiagram, TimelineDiagram } from "@mermaid/types";

const COLUMN_WIDTH = 150;
const COLUMN_GAP = 14;

/** Draw a timeline. */
/**
 * The tinted bands that group columns under a section heading.
 *
 * A timeline and a journey draw this identically, and it used to be two 37-line copies
 * differing only in which field held the section name — so the one decoration the two are
 * supposed to agree on was the one kept in step by hand. Named fields rather than nine
 * positional arguments, because `columnWidth`, `top`, `bandHeight` and `fontSize` are all
 * bare numbers and a transposed pair would type-check.
 *
 * An empty section is skipped and does not consume a palette slot: it would otherwise leave
 * a gap in the run of colours for a band nobody can see.
 */
function sectionBands(options: {
  readonly sections: readonly string[];
  readonly sectionOf: readonly string[];
  readonly columnWidth: number;
  readonly centreOf: (position: number) => number;
  readonly top: number;
  readonly bandHeight: number;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly theme: Theme;
}): DrawNode[] {
  const { sections, sectionOf, columnWidth, centreOf, top, fontSize, fontFamily, theme } = options;
  if (options.bandHeight <= 0) {
    return [];
  }
  const out: DrawNode[] = [];
  const height = options.bandHeight - 6;
  let index = 0;
  for (const name of sections) {
    const covered = sectionOf
      .map((section, position) => ({ section, position }))
      .filter(entry => entry.section === name);
    if (covered.length === 0) {
      continue;
    }
    const left = centreOf(covered[0].position) - columnWidth / 2;
    const right = centreOf(covered[covered.length - 1].position) + columnWidth / 2;
    const fill = theme.palette[index % theme.palette.length];
    out.push({
      kind: "rect",
      x: left,
      y: top,
      width: right - left,
      height,
      rx: 4,
      paint: { fill }
    });
    out.push({
      kind: "text",
      x: (left + right) / 2,
      y: top + height / 2 + fontSize * BASELINE_SHIFT,
      lines: [{ text: name, dy: 0 }],
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "middle",
        bold: true,
        fill: theme.paletteText(fill)
      }
    });
    index++;
  }
  return out;
}

export function timelineDrawList(
  diagram: TimelineDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize, family: fontFamily };
  const eventStyle: DrawTextStyle = { size: fontSize - 1, family: fontFamily };
  const periods = diagram.periods;
  if (periods.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const wrapped = periods.map(period => ({
    period,
    label: wrapText(period.label, style, COLUMN_WIDTH - 20),
    events: period.events.map(event => wrapText(event, eventStyle, COLUMN_WIDTH - 26))
  }));

  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const hasSections = diagram.sections.some(name => name !== "");
  const sectionHeight = hasSections ? fontSize * 2.2 : 0;
  const labelHeight =
    Math.max(...wrapped.map(entry => entry.label.length)) * fontSize * LINE_HEIGHT + 14;

  const top = padding + titleHeight + sectionHeight;
  const spineY = top + labelHeight + 16;
  const eventTop = spineY + 22;

  const eventHeights = wrapped.map(entry =>
    entry.events.reduce((sum, lines) => sum + lines.length * (fontSize - 1) * LINE_HEIGHT + 18, 0)
  );
  const width = padding * 2 + periods.length * COLUMN_WIDTH + (periods.length - 1) * COLUMN_GAP;
  const height = eventTop + Math.max(20, Math.max(...eventHeights)) + padding;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  const centreOf = (index: number): number =>
    padding + index * (COLUMN_WIDTH + COLUMN_GAP) + COLUMN_WIDTH / 2;

  // Section bands across the columns they cover.
  children.push(
    ...sectionBands({
      sections: diagram.sections,
      sectionOf: wrapped.map(entry => entry.period.section),
      columnWidth: COLUMN_WIDTH,
      centreOf,
      top: padding + titleHeight,
      bandHeight: sectionHeight,
      fontSize,
      fontFamily,
      theme
    })
  );

  // The spine.
  children.push({
    kind: "polyline",
    points: [
      { x: padding, y: spineY },
      { x: width - padding, y: spineY }
    ],
    paint: { stroke: theme.nodeStroke, strokeWidth: 2 }
  });

  wrapped.forEach((entry, index) => {
    const cx = centreOf(index);
    const step = fontSize * LINE_HEIGHT;
    children.push({
      kind: "text",
      x: cx,
      y: top + step + fontSize * BASELINE_SHIFT - fontSize * 0.4,
      lines: entry.label.map((text, line) => ({ text, dy: line * step })),
      style: {
        size: fontSize,
        family: fontFamily,
        anchor: "middle",
        bold: true,
        fill: theme.nodeText
      }
    });
    // A dot on the spine marks where the period sits.
    children.push({
      kind: "ellipse",
      cx,
      cy: spineY,
      rx: 5,
      ry: 5,
      paint: { fill: theme.nodeStroke }
    });

    let y = eventTop;
    entry.events.forEach((lines, position) => {
      const boxHeight = lines.length * (fontSize - 1) * LINE_HEIGHT + 12;
      children.push({
        kind: "rect",
        x: cx - COLUMN_WIDTH / 2 + 8,
        y,
        width: COLUMN_WIDTH - 16,
        height: boxHeight,
        rx: 4,
        paint: {
          fill: theme.palette[position % theme.palette.length],
          stroke: theme.edgeLabelBackground,
          strokeWidth: 1
        }
      });
      const eventStep = (fontSize - 1) * LINE_HEIGHT;
      children.push({
        kind: "text",
        x: cx,
        y:
          y +
          boxHeight / 2 -
          ((lines.length - 1) * eventStep) / 2 +
          (fontSize - 1) * BASELINE_SHIFT,
        lines: lines.map((text, line) => ({ text, dy: line * eventStep })),
        style: {
          size: fontSize - 1,
          family: fontFamily,
          anchor: "middle",
          fill: theme.paletteText(theme.palette[position % theme.palette.length])
        }
      });
      y += boxHeight + 6;
    });
  });

  return { width, height, children };
}

/** Draw a user journey. */
export function journeyDrawList(
  diagram: JourneyDiagram,
  theme: Theme,
  fontSize: number,
  fontFamily: string,
  padding: number
): DrawList {
  const style: DrawTextStyle = { size: fontSize - 1, family: fontFamily };
  const tasks = diagram.tasks;
  if (tasks.length === 0) {
    return { width: padding * 2, height: padding * 2, children: [] };
  }

  const columnWidth = 108;
  const wrapped = tasks.map(task => ({
    task,
    label: wrapText(task.label, style, columnWidth - 12),
    actors: task.actors.join(", ")
  }));

  const titleHeight = diagram.title ? fontSize * 2.4 : 0;
  const sectionHeight = diagram.sections.some(name => name !== "") ? fontSize * 2.2 : 0;
  const plotHeight = 150;
  const labelHeight =
    Math.max(...wrapped.map(entry => entry.label.length)) * fontSize * LINE_HEIGHT + 12;
  const actorHeight = wrapped.some(entry => entry.actors !== "") ? fontSize * 1.6 : 0;

  const axisLeft = padding + 26;
  const plotTop = padding + titleHeight + sectionHeight;
  const width = axisLeft + tasks.length * columnWidth + padding;
  const height = plotTop + plotHeight + labelHeight + actorHeight + padding;

  const centreOf = (index: number): number => axisLeft + index * columnWidth + columnWidth / 2;
  // Five is the top of the scale; a score is a position on it, not a number to read.
  const scoreY = (score: number): number =>
    plotTop + plotHeight - ((score - 1) / 4) * (plotHeight - 24) - 12;

  const children: DrawNode[] = [];
  children.push(...backdrop(theme, width, height));
  children.push(...titleBlock(diagram.title, width, padding, fontSize, fontFamily, theme));

  children.push(
    ...sectionBands({
      sections: diagram.sections,
      sectionOf: wrapped.map(entry => entry.task.section),
      columnWidth: columnWidth,
      centreOf,
      top: padding + titleHeight,
      bandHeight: sectionHeight,
      fontSize,
      fontFamily,
      theme
    })
  );

  // The score axis: five rules, so a reader can place a dot without counting pixels.
  for (let score = 1; score <= 5; score++) {
    const y = scoreY(score);
    children.push({
      kind: "polyline",
      points: [
        { x: axisLeft - 6, y },
        { x: width - padding, y }
      ],
      paint: { stroke: theme.groupStroke, strokeWidth: 0.7, dash: [3, 3] }
    });
    children.push({
      kind: "text",
      x: axisLeft - 12,
      y: y + (fontSize - 3) * BASELINE_SHIFT,
      lines: [{ text: String(score), dy: 0 }],
      style: { size: fontSize - 3, family: fontFamily, anchor: "end", fill: theme.edgeText }
    });
  }

  // The line through the scores, drawn before the dots so they cap it.
  children.push({
    kind: "polyline",
    points: wrapped.map((entry, index) => ({ x: centreOf(index), y: scoreY(entry.task.score) })),
    paint: { stroke: theme.nodeStroke, strokeWidth: 2, lineJoin: "round" }
  });

  wrapped.forEach((entry, index) => {
    const cx = centreOf(index);
    const cy = scoreY(entry.task.score);
    const paint: DrawPaint = {
      // Green at the top of the scale, red at the bottom: the point of the diagram.
      fill:
        entry.task.score >= 4
          ? theme.palette[2]
          : entry.task.score <= 2
            ? theme.palette[1]
            : theme.palette[3],
      stroke: theme.edgeLabelBackground,
      strokeWidth: 2
    };
    children.push({ kind: "ellipse", cx, cy, rx: 9, ry: 9, paint });

    const step = fontSize * LINE_HEIGHT;
    children.push({
      kind: "text",
      x: cx,
      y: plotTop + plotHeight + step,
      lines: entry.label.map((text, line) => ({ text, dy: line * step })),
      style: { size: fontSize - 1, family: fontFamily, anchor: "middle", fill: theme.nodeText }
    });
    if (entry.actors !== "") {
      children.push({
        kind: "text",
        x: cx,
        y: plotTop + plotHeight + labelHeight + fontSize,
        lines: [{ text: entry.actors, dy: 0 }],
        style: {
          size: fontSize - 3,
          family: fontFamily,
          anchor: "middle",
          italic: true,
          fill: theme.edgeText
        }
      });
    }
  });

  return { width, height, children };
}
