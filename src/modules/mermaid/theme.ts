/**
 * Colours and metrics.
 *
 * One place, because a diagram is read as a whole: a node border that disagrees with an
 * edge, or a label that disagrees with a title, looks like a mistake even when each is
 * individually defensible. The defaults follow Mermaid's own light theme closely enough
 * to be recognisable without claiming to be pixel-identical to it.
 */

import { cssColour, relativeLuminance } from "@draw/colour";
import type { Rgba01 } from "@utils/svg-lex";

/**
 * A resolved palette.
 *
 * Each token says what it is *for*, and every renderer is expected to honour that reading:
 *
 * - `nodeText` — words inside a box.
 * - `edgeText` — words on or beside a line, and the furniture of a plot: axis captions,
 *   tick values, category names. An axis belongs to the frame, not to a node.
 * - `title` — the diagram's own title, and nothing else.
 * - `palette` — data. A pie slice, a Gantt bar, a Sankey ribbon, a git lane. These are
 *   deliberately *not* `nodeFill`: a bar is a value, not a box, and colouring it from the
 *   node token would make a chart change colour when a flowchart's boxes were restyled.
 * - `paletteText` — words drawn *on* a palette colour, which need to contrast with it
 *   rather than with the background.
 */
export interface Theme {
  readonly background?: Rgba01;
  readonly nodeFill: Rgba01;
  readonly nodeStroke: Rgba01;
  readonly nodeText: Rgba01;
  readonly edge: Rgba01;
  readonly edgeText: Rgba01;
  /** Painted behind an edge label so the line does not run through the words. */
  readonly edgeLabelBackground: Rgba01;
  readonly groupFill: Rgba01;
  readonly groupStroke: Rgba01;
  readonly title: Rgba01;
  /** Data fills, cycled in order. */
  readonly palette: readonly Rgba01[];
  /**
   * Words drawn on top of a palette colour.
   *
   * A function of the colour rather than a constant, because a palette contains both light
   * and dark entries: Mermaid's own first slice is a pale lilac, and white on it is
   * unreadable. The choice is made from the colour's luminance, which is the one thing that
   * decides whether ink or paper is the legible option.
   */
  readonly paletteText: (on: Rgba01) => Rgba01;
}

/** Overridable colour tokens; anything omitted keeps the default. */
export interface ThemeOptions {
  readonly background?: string;
  readonly nodeFill?: string;
  readonly nodeStroke?: string;
  readonly nodeText?: string;
  readonly edge?: string;
  readonly edgeText?: string;
  readonly edgeLabelBackground?: string;
  readonly groupFill?: string;
  readonly groupStroke?: string;
  readonly title?: string;
  readonly palette?: readonly string[];
  readonly paletteText?: string;
}

/**
 * Mermaid's own default theme, token for token.
 *
 * Taken from the values Mermaid's `base` theme resolves to rather than eyeballed, so a
 * diagram drawn here and one drawn there are recognisably the same diagram. The names
 * differ — Mermaid calls the node fill `primaryColor` and the group fill `secondaryColor`
 * — because a name should say what a token *is* for, and "secondary" says only that
 * somebody numbered it second.
 *
 * `edgeLabelBackground` is the one worth pointing at: Mermaid paints a grey panel behind
 * an edge label rather than a white one, so the label reads as sitting on the diagram
 * instead of punching a hole in it.
 */
const DEFAULTS = {
  /** `primaryColor` */
  nodeFill: "#ECECFF",
  /** `primaryBorderColor` */
  nodeStroke: "#9370DB",
  /** `primaryTextColor` / `textColor` */
  nodeText: "#333333",
  /** `lineColor` */
  edge: "#333333",
  edgeText: "#333333",
  /** `edgeLabelBackground` */
  edgeLabelBackground: "#e8e8e8",
  /** `secondaryColor` — Mermaid's cluster fill */
  groupFill: "#ffffde",
  /** `secondaryBorderColor` */
  groupStroke: "#aaaa33",
  /** `titleColor` */
  title: "#333333",
  /** White reads on every colour in the palette below. */
  paletteText: "#ffffff",
  /**
   * `pie1`…`pie12`, which Mermaid derives by rotating the primary hue. Reproduced as the
   * literal sequence: deriving them here would mean re-implementing Mermaid's colour
   * arithmetic to arrive at numbers that are already known.
   */
  palette: [
    "#ECECFF",
    "#ff6384",
    "#36a2eb",
    "#ffce56",
    "#4bc0c0",
    "#9966ff",
    "#ff9f40",
    "#c9cbcf",
    "#7bc043",
    "#f37736",
    "#ee4035",
    "#0392cf"
  ]
} as const;

/** Resolve a theme, filling anything the caller left out. */
export function resolveTheme(options: ThemeOptions = {}): Theme {
  return {
    ...(options.background === undefined || options.background === "transparent"
      ? {}
      : { background: cssColour(options.background) }),
    nodeFill: cssColour(options.nodeFill ?? DEFAULTS.nodeFill),
    nodeStroke: cssColour(options.nodeStroke ?? DEFAULTS.nodeStroke),
    nodeText: cssColour(options.nodeText ?? DEFAULTS.nodeText),
    edge: cssColour(options.edge ?? DEFAULTS.edge),
    edgeText: cssColour(options.edgeText ?? DEFAULTS.edgeText),
    edgeLabelBackground: cssColour(options.edgeLabelBackground ?? DEFAULTS.edgeLabelBackground),
    groupFill: cssColour(options.groupFill ?? DEFAULTS.groupFill),
    groupStroke: cssColour(options.groupStroke ?? DEFAULTS.groupStroke),
    title: cssColour(options.title ?? DEFAULTS.title),
    paletteText: contrastWith(
      cssColour(options.paletteText ?? DEFAULTS.paletteText),
      cssColour(options.nodeText ?? DEFAULTS.nodeText)
    ),
    palette: (options.palette ?? DEFAULTS.palette).map(token => cssColour(token))
  };
}

/**
 * Choose between a light and a dark ink for whatever colour the text lands on.
 *
 * Relative luminance with the sRGB coefficients, thresholded near the middle: above it the
 * background is light and wants dark ink, below it the reverse. Comparing the raw channels
 * instead would call pure blue "light".
 */
function contrastWith(light: Rgba01, dark: Rgba01): (on: Rgba01) => Rgba01 {
  return on => {
    const luminance = relativeLuminance(on);
    return luminance > 0.6 ? dark : light;
  };
}

/**
 * Space between the baselines of stacked lines, as a multiple of the font size.
 *
 * One definition beside {@link BASELINE_SHIFT}, because the two are read together every time
 * a producer stacks text: six renderers had their own `1.3` and any one of them could drift
 * without the others noticing. The two diagram types that genuinely use a different figure —
 * a class compartment at 1.45, a model box at 1.35 — keep their own, and say so.
 */
export const LINE_HEIGHT = 1.3;

/**
 * The distance from a line of text's centre to its baseline.
 *
 * The display list positions text by its baseline, which is what every backend can
 * honour; SVG's `dominant-baseline` is not portable to a content stream or a scanline
 * rasteriser. Centring therefore has to happen here, and 0.36em is the usual
 * approximation of half the cap height for the sans-serif faces this draws with.
 */
export const BASELINE_SHIFT = 0.36;
