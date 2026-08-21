/**
 * SVG → normalised geometry, for proving two renderers draw the same picture.
 *
 * Golden *hashes* cannot survive a re-implementation: any change to attribute
 * order or number formatting breaks them, so the only way through is to
 * re-baseline — which means the new output is checked against itself. This
 * extractor compares what actually matters instead: which shapes exist, where
 * they are and how they are painted. A rewritten emitter that produces the same
 * geometry is provably equivalent; one that moves a shape is not.
 *
 * Two *representations* of the same picture must compare equal, or the tool would
 * only be a slower hash. So it canonicalises the benign differences:
 *
 * - a `<path>` built from nothing but `M` and `L` is the same shape as a
 *   `<polyline>` / `<polygon>` with those points, and is reported as one;
 * - a `<line>` is a two-point `<polyline>`;
 * - a percentage length is resolved against the root viewport, so `width="100%"`
 *   and `width="240"` on a 240-unit canvas are the same edge;
 * - an absent `stroke-width` is `1`, which is SVG's initial value;
 * - `fill-opacity` / `stroke-opacity` / `opacity` fold into the recorded colour,
 *   because a translucent paint is a property of the paint however it is spelled.
 *
 * That last one has a limit worth knowing before leaning on this as an oracle:
 * folding element `opacity` into both paints makes `opacity="0.5"` and a pair of
 * `fill-opacity="0.5" stroke-opacity="0.5"` record identically, but a renderer does
 * not draw them identically. Element opacity composites the finished shape once, so
 * where a translucent stroke covers its own fill the two differ. A matching hash
 * therefore proves the geometry and the paints agree — not that compositing does.
 *
 * Anything that would move a pixel — a coordinate, a colour, a curve where there
 * was a line — still differs.
 *
 * Intended for tests only.
 */

import { parseCssColor, parseSvgAttributes, parseSvgNumberList } from "@utils/svg-lex";

/** One shape, reduced to the properties a viewer would notice. */
export interface SvgShape {
  readonly kind: string;
  /** Ordered coordinate list; the meaning depends on `kind`. */
  readonly coords: readonly number[];
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly text?: string;
}

const ELEMENT_RE =
  /<(rect|line|circle|ellipse|polyline|polygon|path)\b([^>]*)\/?>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;

/** Round to a fixed precision so formatting differences do not register. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalise a colour token to `#rrggbb` plus alpha, or undefined for no paint.
 *
 * `opacityAttrs` are multiplied into the alpha so that `fill="#f00"` with
 * `fill-opacity="0.5"` and an inline `rgba(255,0,0,0.5)` record identically —
 * both are half-transparent red.
 */
function paint(
  token: string | undefined,
  ...opacityAttrs: (string | undefined)[]
): string | undefined {
  const base = parseCssColor(token);
  if (!base) {
    return undefined;
  }
  let alpha = base.a;
  for (const raw of opacityAttrs) {
    if (raw === undefined) {
      continue;
    }
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) {
      alpha *= Math.max(0, Math.min(1, value));
    }
  }
  const parsed = { ...base, a: alpha };
  const channel = (component: number): string =>
    Math.round(component * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${channel(parsed.r)}${channel(parsed.g)}${channel(parsed.b)}`;
  return parsed.a >= 1 ? hex : `${hex}@${round(parsed.a)}`;
}

/** The root viewport, needed to resolve percentage lengths. */
interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Read the root `<svg>` extent, preferring `viewBox` over the presentation size. */
function readViewport(svg: string): Viewport {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  const attrs = parseSvgAttributes(root?.[1] ?? "");
  const viewBox = parseSvgNumberList(attrs.viewBox);
  if (viewBox.length >= 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return {
    width: Number.parseFloat(attrs.width ?? "") || 0,
    height: Number.parseFloat(attrs.height ?? "") || 0
  };
}

/** Whether an attribute measures along x rather than y. */
function isHorizontal(key: string): boolean {
  return key.startsWith("x") || key === "width" || key === "cx" || key === "rx" || key === "r";
}

/**
 * Numbers named by `keys`, in order, defaulting to 0.
 *
 * A trailing `%` resolves against the viewport on the matching axis: SVG does the
 * same, so `width="100%"` and `width="240"` describe one edge, not two.
 */
function coordsOf(
  attrs: Record<string, string>,
  keys: readonly string[],
  viewport: Viewport
): number[] {
  return keys.map(key => {
    const raw = attrs[key] ?? "0";
    const value = Number.parseFloat(raw) || 0;
    if (raw.trim().endsWith("%")) {
      return round((value / 100) * (isHorizontal(key) ? viewport.width : viewport.height));
    }
    return round(value);
  });
}

/**
 * Extract every shape from an SVG document.
 *
 * `<path>` is reduced to its numeric operands so `M0 0 L5 5` and a re-emitted
 * `M 0 0 L 5 5` compare equal; command letters are kept as a separate string so a
 * line cannot silently become a curve.
 */
export function extractSvgGeometry(svg: string): SvgShape[] {
  const viewport = readViewport(svg);
  const shapes: SvgShape[] = [];
  let match: RegExpExecArray | null;
  ELEMENT_RE.lastIndex = 0;
  while ((match = ELEMENT_RE.exec(svg)) !== null) {
    const isText = match[1] === undefined;
    const attrs = parseSvgAttributes(isText ? (match[3] ?? "") : (match[2] ?? ""));
    const kind = isText ? "text" : match[1].toLowerCase();
    const fillPaint = paint(attrs.fill, attrs["fill-opacity"], attrs.opacity);
    const strokePaint = paint(attrs.stroke, attrs["stroke-opacity"], attrs.opacity);
    const common = {
      ...(fillPaint === undefined ? {} : { fill: fillPaint }),
      ...(strokePaint === undefined ? {} : { stroke: strokePaint }),
      // SVG's initial stroke-width is 1, so an absent attribute and an explicit
      // "1" describe the same stroke.
      ...(strokePaint === undefined
        ? {}
        : {
            strokeWidth:
              attrs["stroke-width"] === undefined
                ? 1
                : round(Number.parseFloat(attrs["stroke-width"]))
          })
    };

    switch (kind) {
      case "rect":
        shapes.push({
          kind,
          coords: coordsOf(attrs, ["x", "y", "width", "height"], viewport),
          ...common
        });
        break;
      case "line":
        shapes.push({
          kind: "polyline",
          coords: coordsOf(attrs, ["x1", "y1", "x2", "y2"], viewport),
          ...common
        });
        break;
      case "circle":
        shapes.push({ kind, coords: coordsOf(attrs, ["cx", "cy", "r"], viewport), ...common });
        break;
      case "ellipse":
        shapes.push({
          kind,
          coords: coordsOf(attrs, ["cx", "cy", "rx", "ry"], viewport),
          ...common
        });
        break;
      case "polyline":
      case "polygon":
        shapes.push({
          kind,
          coords: parseSvgNumberList(attrs.points).map(round),
          ...common
        });
        break;
      case "path": {
        const commands = (attrs.d ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
        const coords = parseSvgNumberList((attrs.d ?? "").replace(/[A-Za-z]/g, " ")).map(round);
        // An M/L-only path is a polyline (or a polygon when it closes); report it
        // as such so re-emitting the same shape a different way is not a "change".
        if (/^ML*Z?$/.test(commands)) {
          shapes.push({ kind: commands.endsWith("Z") ? "polygon" : "polyline", coords, ...common });
          break;
        }
        shapes.push({ kind, coords, text: commands, ...common });
        break;
      }
      case "text":
        shapes.push({
          kind,
          coords: coordsOf(attrs, ["x", "y"], viewport),
          text: (match[4] ?? "").replace(/<[^>]*>/g, ""),
          ...common
        });
        break;
    }
  }
  return shapes;
}

/**
 * A stable, human-readable rendering of the geometry.
 *
 * Diffing this in a failing test shows *which shape moved*, unlike a hash.
 */
export function describeSvgGeometry(svg: string): string {
  return extractSvgGeometry(svg)
    .map(shape =>
      [
        shape.kind,
        shape.coords.join(","),
        shape.text === undefined ? "" : `"${shape.text}"`,
        shape.fill === undefined ? "" : `fill=${shape.fill}`,
        shape.stroke === undefined ? "" : `stroke=${shape.stroke}`,
        shape.strokeWidth === undefined ? "" : `sw=${shape.strokeWidth}`
      ]
        .filter(part => part !== "")
        .join(" ")
    )
    .join("\n");
}
