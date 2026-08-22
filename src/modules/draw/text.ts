/**
 * Text measurement for display-list producers.
 *
 * A producer has to know how wide a label is before it can place anything: a legend
 * reserves room for its longest entry, a diagram sizes a box around its caption, an axis
 * decides whether a tick label fits or has to be dropped. That is layout, and it happens
 * before a single node exists.
 *
 * The measurement itself lives in `@utils/text-measure` (Layer 0, no module
 * dependencies). This wrapper exists to express it in the terms the display list already
 * uses — {@link DrawTextStyle} — rather than making every producer translate between a
 * font descriptor and a text style.
 *
 * It was reachable only through `@excel/chart/shared/chart-utils`, which is Layer 4.
 * Anything sitting beside this module could draw text but not measure it, which meant it
 * could not lay anything out — the one thing that stopped a non-chart producer from being
 * written against this engine.
 */

import { DEFAULT_TEXT_FAMILY } from "@draw/types";
import type { DrawTextStyle } from "@draw/types";
import { measureTextWidthPx } from "@utils/text-measure";

/**
 * Points per CSS pixel.
 *
 * `measureTextWidthPx` returns a CSS-pixel width for a point size, so it carries a 96/72
 * scale. A display list is a single coordinate space in which text is *drawn* at
 * `style.size` units — SVG writes `font-size="${size}"` and the PDF surface passes the
 * number through as points — so a pixel width over-reports every label by 4/3. Getting
 * this wrong pushed legends wider, shifted centred titles left, and ellipsised axis
 * labels that in fact fit.
 */
export const POINTS_PER_PIXEL = 72 / 96;

/**
 * The width of one line of text, in the display list's own units.
 *
 * Multi-line input reports the widest line, which is what a box around it has to be.
 */
export function measureText(text: string, style: DrawTextStyle): number {
  if (!text) {
    return 0;
  }
  return (
    measureTextWidthPx(text, {
      name: style.family ?? DEFAULT_TEXT_FAMILY,
      size: style.size,
      bold: style.bold ?? false,
      italic: style.italic ?? false
    }) * POINTS_PER_PIXEL
  );
}

/**
 * Break text into lines no wider than `maxWidth`, breaking at spaces where possible.
 *
 * A word longer than the limit is left on a line of its own rather than split: breaking
 * inside a word needs hyphenation rules to look like anything but a bug, and a caller who
 * wants a hard break can measure and cut for itself.
 *
 * Existing newlines are honoured — they are the author's own breaks, and wrapping must
 * not swallow them.
 */
export function wrapText(text: string, style: DrawTextStyle, maxWidth: number): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/);
  if (maxWidth <= 0) {
    return paragraphs;
  }
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/(\s+)/).filter(part => part !== "");
    let current = "";
    for (const word of words) {
      const candidate = current + word;
      if (current !== "" && measureText(candidate.trimEnd(), style) > maxWidth) {
        lines.push(current.trimEnd());
        // A run of whitespace that lands at a break is consumed by it.
        current = word.trim() === "" ? "" : word;
        continue;
      }
      current = candidate;
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

/**
 * The width of the widest of several strings.
 *
 * A producer sizes a column, a gutter or a legend around the longest label it has to fit, so
 * this is the shape every layout reaches for. It lives beside {@link measureText} because
 * spreading a mapped array into `Math.max` has one failure mode worth hiding: `Math.max()`
 * with no arguments is `-Infinity`, which silently poisons the arithmetic downstream rather
 * than throwing. An empty list measures zero.
 */
export function widestText(texts: readonly string[], style: DrawTextStyle): number {
  let widest = 0;
  for (const text of texts) {
    widest = Math.max(widest, measureText(text, style));
  }
  return widest;
}
