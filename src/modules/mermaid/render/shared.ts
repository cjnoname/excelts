/**
 * The marks every diagram type puts down.
 *
 * A title, a backdrop, a centred label, an arrowhead. Each of these had a copy per renderer
 * — the title node was three byte-identical functions plus ten inlined duplicates — and a
 * copy per renderer is a decision that can drift: two of the three arrowhead implementations
 * had picked different sizes, so the same library drew a sequence arrow and a flowchart arrow
 * at 10 and 11 units.
 *
 * These live here rather than in `render/flowchart.ts` because a pie chart importing the
 * flowchart renderer to borrow its text helper reads as a dependency that is not there.
 */

import type { DrawNode, DrawPaint, DrawPoint, DrawTextStyle } from "@draw/types";
import { BASELINE_SHIFT, LINE_HEIGHT } from "@mermaid/theme";
import type { Theme } from "@mermaid/theme";
import type { Rgba01 } from "@utils/svg-lex";

/** The diagram's own title, centred at `x`. */
export function titleNode(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  theme: Theme
): DrawNode {
  return {
    kind: "text",
    x,
    y,
    lines: [{ text, dy: 0 }],
    style: {
      size: fontSize * 1.35,
      family: fontFamily,
      anchor: "middle",
      bold: true,
      fill: theme.title
    }
  };
}

/**
 * The background, when one was asked for.
 *
 * Returns a list so a caller can spread it unconditionally: `children.push(...backdrop(…))`
 * puts nothing down for a transparent diagram, which is what "omitted means transparent"
 * means. It must stay the first node in the list — several tests read `children[0]` — which
 * spreading at the top of each renderer preserves.
 */
export function backdrop(theme: Theme, width: number, height: number): DrawNode[] {
  return theme.background === undefined
    ? []
    : [{ kind: "rect", x: 0, y: 0, width, height, paint: { fill: theme.background } }];
}

/**
 * The title above a diagram that lays itself out from its own size.
 *
 * Returns a list so the caller can spread it unconditionally, the same way {@link backdrop}
 * does — an absent title contributes nothing rather than needing an `if` at each of the
 * thirteen places that draw one. Those thirteen had the identical five-line block with the
 * identical six arguments, which is thirteen chances to pass the wrong `y`.
 */
export function titleBlock(
  title: string | undefined,
  width: number,
  padding: number,
  fontSize: number,
  fontFamily: string,
  theme: Theme
): DrawNode[] {
  return title === undefined
    ? []
    : [titleNode(title, width / 2, padding + fontSize, fontSize, fontFamily, theme)];
}

/**
 * The title of a diagram whose position was decided by the shared layout.
 *
 * The five graph-shaped diagrams each remembered to append this themselves. `fromLayout` in
 * `index.ts` already unified the background and the canvas size for them; the title was the
 * one part left outside, so it is the one part that could still be forgotten.
 */
export function layoutTitleBlock(
  title: { readonly text: string; readonly x: number; readonly y: number } | undefined,
  fontSize: number,
  fontFamily: string,
  theme: Theme
): DrawNode[] {
  return title === undefined
    ? []
    : [titleNode(title.text, title.x, title.y, fontSize, fontFamily, theme)];
}

/**
 * A label centred in its box, with the baseline offset the engine cannot infer.
 *
 * The display list positions text by its baseline, because that is what every backend can
 * honour — SVG's `dominant-baseline` has no counterpart in a content stream or a scanline
 * rasteriser. Vertical centring is therefore arithmetic a producer does, and doing it in one
 * place is what keeps eight renderers agreeing about where the middle of a box is.
 */
export function centredText(
  box: { x: number; y: number; width: number; height: number },
  lines: readonly string[],
  fontSize: number,
  fontFamily: string,
  fill: Rgba01,
  extra: Partial<DrawTextStyle> = {}
): DrawNode {
  const step = fontSize * LINE_HEIGHT;
  const first =
    box.y + box.height / 2 - ((lines.length - 1) * step) / 2 + fontSize * BASELINE_SHIFT;
  return {
    kind: "text",
    x: box.x + box.width / 2,
    y: first,
    lines: lines.map((text, index) => ({ text, dy: index * step })),
    style: { size: fontSize, family: fontFamily, anchor: "middle", fill, ...extra }
  };
}

/** Default arrowhead geometry, in diagram units. */
export const ARROW_LENGTH = 11;
export const ARROW_HALF_WIDTH = 4.5;

/**
 * A filled triangle at `tip`, aimed along the segment arriving from `towards`.
 *
 * A marker is an SVG concept with no counterpart in a content stream or a scanline
 * rasteriser, so a producer lowers it to a triangle — which every backend already draws.
 * The size is a parameter because a sequence diagram's arrows are drawn slightly smaller
 * than a flowchart's; before this it was a parameter by accident, in that each copy had
 * chosen its own numbers.
 */
export function arrowHead(
  tip: DrawPoint,
  towards: DrawPoint,
  paint: DrawPaint,
  length = ARROW_LENGTH,
  halfWidth = ARROW_HALF_WIDTH
): DrawNode[] {
  const dx = tip.x - towards.x;
  const dy = tip.y - towards.y;
  const span = Math.hypot(dx, dy);
  if (span === 0) {
    return [];
  }
  const ux = dx / span;
  const uy = dy / span;
  const baseX = tip.x - ux * length;
  const baseY = tip.y - uy * length;
  return [
    {
      kind: "polyline",
      closed: true,
      points: [
        { x: tip.x, y: tip.y },
        { x: baseX - uy * halfWidth, y: baseY + ux * halfWidth },
        { x: baseX + uy * halfWidth, y: baseY - ux * halfWidth }
      ],
      paint
    }
  ];
}

/** Trim a number to something an axis or a legend can carry. */
export function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * A legend entry: a swatch and its name.
 *
 * The row spacing is left to the caller, because a pie chart and a radar chart space their
 * entries differently and that is a layout decision rather than part of the entry.
 */
export function legendEntry(
  x: number,
  y: number,
  colour: Rgba01,
  text: string,
  fontSize: number,
  fontFamily: string,
  theme: Theme
): DrawNode[] {
  return [
    { kind: "rect", x, y, width: 13, height: 13, rx: 2, paint: { fill: colour } },
    {
      kind: "text",
      x: x + 20,
      y: y + 6.5 + fontSize * BASELINE_SHIFT,
      lines: [{ text, dy: 0 }],
      style: { size: fontSize, family: fontFamily, anchor: "start", fill: theme.nodeText }
    }
  ];
}
