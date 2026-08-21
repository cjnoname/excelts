/**
 * Structured drawing IR — the interchange format for everything this library
 * draws.
 *
 * ## Why this exists
 *
 * The renderers grew up passing an *SVG string* between themselves: the chart
 * engine emitted SVG, then the Node PNG fallback re-parsed that string with a
 * regex scanner and the PDF importer parsed it again with a second, differently
 * capable parser. Every backend therefore had its own idea of what an attribute
 * meant, and the same picture came out differently depending on which one you
 * asked — dashes vanished, opacity was ignored, rotations mirrored, colours were
 * read with the wrong byte order.
 *
 * A display list removes the round trip. Producers describe geometry once;
 * each backend consumes the same nodes. SVG becomes one *output* rather than the
 * lingua franca.
 *
 * ## Shape of the model
 *
 * - Coordinates are in a single user space with **Y pointing down**, matching
 *   SVG and the chart scene. Backends that are Y-up (PDF) flip in their own
 *   adapter, which is the only place that knows about it.
 * - `group` carries an affine transform. {@link renderDrawList} maintains the
 *   current transform and hands surfaces **already-transformed, absolute**
 *   coordinates, so a surface never implements transform stacking. Producers get
 *   convenient nesting; backends stay flat.
 * - Paths are limited to move / line / cubic / close. Arcs are converted to
 *   cubics by {@link arcToCubics} at construction time, because every backend can
 *   draw a cubic and only some can draw an arc.
 */

import type { Rgba01 } from "@utils/svg-lex";

/**
 * A 2-D affine transform, in the same order as SVG's `matrix(a b c d e f)`:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export interface DrawMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** The identity transform. */
export const IDENTITY: DrawMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A point in user space. */
export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

/** How a shape is painted. All fields are optional; omitted means "no paint". */
export interface DrawPaint {
  readonly fill?: Rgba01;
  readonly stroke?: Rgba01;
  /** Stroke width in user units. Defaults to 1 when a stroke is present. */
  readonly strokeWidth?: number;
  /**
   * Dash pattern in user units, alternating on/off. An odd-length array repeats
   * to form an even cycle, as SVG specifies.
   */
  readonly dash?: readonly number[];
  /** Defaults to `"nonzero"`, matching SVG. */
  readonly fillRule?: "nonzero" | "evenodd";
  /**
   * How the corners of a stroke are shaped. Defaults to `"miter"`, matching SVG
   * and PDF.
   *
   * Honoured by every backend: SVG writes the presentation attributes, the PDF
   * surface sets the content stream's `j` and `J`, and the rasteriser fills a disc of
   * the stroke's own radius at each corner and end — which is what a round join and
   * a round cap are. Before this field existed, a smooth line chart's rounded joins
   * reached the SVG output alone, because that was the only renderer that read the
   * flag.
   *
   * The rasteriser draws `bevel` and `square` as the default shape: filling the
   * notch is one disc, whereas mitring or squaring it off needs the segment's
   * direction, and nothing asks for those.
   */
  readonly lineJoin?: "miter" | "round" | "bevel";
  /** How a stroke's ends are shaped. Defaults to `"butt"`, matching SVG and PDF. */
  readonly lineCap?: "butt" | "round" | "square";
}

/** One segment of a path. */
export type DrawPathCommand =
  | { readonly op: "move"; readonly x: number; readonly y: number }
  | { readonly op: "line"; readonly x: number; readonly y: number }
  | {
      readonly op: "cubic";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: "close" };

/**
 * The face used when a text style names none.
 *
 * A single source for it, because measurement and rendering have to agree: text was
 * measured as Arial while SVG wrote no `font-family` at all — leaving the choice to the
 * viewer's default — and the PDF builder fell back to Helvetica. Any layout computed from
 * the measured width was then wrong by whatever the difference happened to be.
 */
export const DEFAULT_TEXT_FAMILY = "arial";

/** Horizontal alignment of a text run around its origin. */
export type DrawTextAnchor = "start" | "middle" | "end";

/** Font selection and size for a text node. */
export interface DrawTextStyle {
  /** Size in user units. */
  readonly size: number;
  readonly family?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly anchor?: DrawTextAnchor;
  readonly fill?: Rgba01;
}

/**
 * One line of a text node.
 *
 * `dy` is the baseline offset from the node's origin **in user units** — already
 * resolved, so no backend has to know about `em`.
 */
export interface DrawTextLine {
  readonly text: string;
  readonly dy: number;
  /** Overrides the node's `x` for this line. */
  readonly x?: number;
}

/** An axis-aligned clip rectangle in user space. */
export interface DrawClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A node in the display list. */
export type DrawNode =
  | {
      readonly kind: "group";
      readonly transform?: DrawMatrix;
      /**
       * Restrict this group's content to a rectangle, expressed in the group's
       * own coordinate space — the same space its children use, so the clip moves
       * and scales with `transform`.
       *
       * Only axis-aligned rectangles are supported, deliberately: that is what a
       * plot area needs, every backend can express it exactly (SVG `clipPath`,
       * PDF `W n`, a scissor test in the rasteriser), and an arbitrary clip path
       * in a scanline rasteriser is a different order of problem. Nested clips
       * intersect.
       */
      readonly clip?: DrawClip;
      /**
       * Reference an SVG filter from {@link DrawList.svgDefs}, applied to this
       * group's content.
       *
       * **SVG-only, and named to say so.** A DrawingML shadow / glow / reflection
       * has no counterpart in a PDF content stream or a scanline rasteriser, so
       * every other surface ignores it. That is not a new limitation — it is what
       * the per-backend renderers already did, now explicit in one place instead
       * of implicit in three. Pretending the field were portable would be the
       * dishonest option.
       */
      readonly svgFilterId?: string;
      readonly children: readonly DrawNode[];
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      /** Corner radius. */
      readonly rx?: number;
      readonly paint: DrawPaint;
    }
  | {
      readonly kind: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly paint: DrawPaint;
    }
  | {
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly paint: DrawPaint;
    }
  | {
      readonly kind: "polyline";
      readonly points: readonly DrawPoint[];
      readonly closed?: boolean;
      readonly paint: DrawPaint;
    }
  | {
      readonly kind: "path";
      readonly commands: readonly DrawPathCommand[];
      readonly paint: DrawPaint;
    }
  | {
      /**
       * A circular sector — a pie slice, or an annular one when
       * `innerRadius > 0`.
       *
       * A first-class primitive rather than a path because the three backends do
       * it in three genuinely different ways, and lowering it upstream would make
       * two of them worse: SVG has arcs natively, PDF needs cubics, and the
       * rasteriser can test radius-and-angle per pixel for an exact edge instead
       * of approximating a polygon. The old pipeline smuggled the parameters past
       * the SVG string in a `data-sector` attribute so the rasteriser could
       * recover them; expressing them in the model removes that channel.
       *
       * Angles are radians, measured clockwise from the positive x-axis in this
       * Y-down space, matching `Math.atan2` on screen coordinates.
       */
      readonly kind: "sector";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly innerRadius: number;
      readonly startAngle: number;
      readonly endAngle: number;
      readonly paint: DrawPaint;
    }
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly lines: readonly DrawTextLine[];
      readonly style: DrawTextStyle;
      /**
       * Clockwise rotation in degrees about `(x, y)`, in this Y-down user space.
       * Kept as an angle rather than folded into a group transform because text
       * cannot be sheared by any backend here, and every backend needs the angle
       * explicitly.
       */
      readonly rotate?: number;
    };

/** A complete picture: a size in user units plus its content. */
export interface DrawList {
  readonly width: number;
  readonly height: number;
  readonly children: readonly DrawNode[];
  /**
   * Raw markup for the SVG `<defs>` block, referenced by
   * `DrawNode.group.svgFilterId`. See that field for why this is SVG-only.
   */
  readonly svgDefs?: readonly string[];
}

// =============================================================================
// Matrix helpers
// =============================================================================

/** Compose two transforms: apply `inner` first, then `outer`. */
export function multiply(outer: DrawMatrix, inner: DrawMatrix): DrawMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  };
}

/** Apply a transform to a point. */
export function apply(m: DrawMatrix, x: number, y: number): DrawPoint {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** A translation. */
export function translate(tx: number, ty: number): DrawMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/** A scale about the origin. */
export function scale(sx: number, sy = sx): DrawMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/**
 * A clockwise rotation about `(cx, cy)`, matching SVG's `rotate(a cx cy)` in
 * this Y-down space.
 */
export function rotate(degrees: number, cx = 0, cy = 0): DrawMatrix {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx - cx * cos + cy * sin,
    f: cy - cx * sin - cy * cos
  };
}

/**
 * The uniform-equivalent scale factor of a transform.
 *
 * Used for values that a backend can only express as a single scalar — stroke
 * width, font size. `sqrt(|det|)` is the factor that preserves area, which is
 * the least-wrong choice under a non-uniform transform.
 */
export function uniformScale(m: DrawMatrix): number {
  const determinant = Math.abs(m.a * m.d - m.b * m.c);
  return determinant > 0 ? Math.sqrt(determinant) : 1;
}

/**
 * The rotation a transform applies, in degrees clockwise.
 *
 * Only meaningful for the rotation/scale transforms produced here; a sheared
 * transform has no single answer and returns the angle of its x-axis.
 */
export function rotationOf(m: DrawMatrix): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

// =============================================================================
// Path construction
// =============================================================================

/**
 * Convert an SVG-style elliptical arc to cubic Béziers.
 *
 * Arcs are the one primitive the backends disagree about — SVG has them
 * natively, PDF does not, and the rasteriser approximates them — so they are
 * lowered here, once, using the endpoint parameterisation from the SVG spec.
 *
 * @param from - Current point.
 * @param rx - X radius (absolute value taken; zero degrades to a line).
 * @param ry - Y radius.
 * @param rotationDegrees - X-axis rotation of the ellipse.
 * @param largeArc - The `large-arc-flag`.
 * @param sweep - The `sweep-flag`.
 * @param to - End point.
 */
export function arcToCubics(
  from: DrawPoint,
  rx: number,
  ry: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  to: DrawPoint
): DrawPathCommand[] {
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  if (radiusX === 0 || radiusY === 0 || (from.x === to.x && from.y === to.y)) {
    return [{ op: "line", x: to.x, y: to.y }];
  }
  const phi = (rotationDegrees * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: to the ellipse's own frame.
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Step 2: enlarge the radii if they cannot span the chord.
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const factor = Math.sqrt(lambda);
    radiusX *= factor;
    radiusY *= factor;
  }

  // Step 3: centre.
  const rxSq = radiusX * radiusX;
  const rySq = radiusY * radiusY;
  const numerator = Math.max(0, rxSq * rySq - rxSq * y1p * y1p - rySq * x1p * x1p);
  const denominator = rxSq * y1p * y1p + rySq * x1p * x1p;
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(numerator / denominator);
  const cxp = (coefficient * radiusX * y1p) / radiusY;
  const cyp = (-coefficient * radiusY * x1p) / radiusX;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  // Step 4: start and sweep angles.
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    return sign * Math.acos(Math.max(-1, Math.min(1, dot / len)));
  };
  const startX = (x1p - cxp) / radiusX;
  const startY = (y1p - cyp) / radiusY;
  const endX = (-x1p - cxp) / radiusX;
  const endY = (-y1p - cyp) / radiusY;
  const theta = angle(1, 0, startX, startY);
  let delta = angle(startX, startY, endX, endY);
  if (!sweep && delta > 0) {
    delta -= 2 * Math.PI;
  } else if (sweep && delta < 0) {
    delta += 2 * Math.PI;
  }

  // Step 5: split into ≤90° segments, each an exact cubic approximation.
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const alpha = ((4 / 3) * Math.tan(step / 4)) as number;
  const commands: DrawPathCommand[] = [];
  let angleAt = theta;
  let pointX = from.x;
  let pointY = from.y;
  for (let i = 0; i < segments; i++) {
    const next = angleAt + step;
    const onEllipse = (t: number): DrawPoint => {
      const cosT = Math.cos(t);
      const sinT = Math.sin(t);
      return {
        x: cx + radiusX * cosPhi * cosT - radiusY * sinPhi * sinT,
        y: cy + radiusX * sinPhi * cosT + radiusY * cosPhi * sinT
      };
    };
    const derivative = (t: number): DrawPoint => {
      const cosT = Math.cos(t);
      const sinT = Math.sin(t);
      return {
        x: -radiusX * cosPhi * sinT - radiusY * sinPhi * cosT,
        y: -radiusX * sinPhi * sinT + radiusY * cosPhi * cosT
      };
    };
    const startDerivative = derivative(angleAt);
    const end = onEllipse(next);
    const endDerivative = derivative(next);
    commands.push({
      op: "cubic",
      x1: pointX + alpha * startDerivative.x,
      y1: pointY + alpha * startDerivative.y,
      x2: end.x - alpha * endDerivative.x,
      y2: end.y - alpha * endDerivative.y,
      x: end.x,
      y: end.y
    });
    angleAt = next;
    pointX = end.x;
    pointY = end.y;
  }
  return commands;
}

/**
 * Lower a sector to move / line / cubic / close, in its own coordinate space.
 *
 * Needed wherever a sector cannot stay a sector: a PDF content stream has no arc
 * operator, and {@link renderNode} falls back to this when the transform is not a
 * plain rotation, since a reflected or non-uniformly scaled sector is no longer a
 * circular one.
 */
export function sectorToPath(
  cx: number,
  cy: number,
  radius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): DrawPathCommand[] {
  const at = (angle: number, r: number): DrawPoint => ({
    x: cx + Math.cos(angle) * r,
    y: cy + Math.sin(angle) * r
  });
  const sweep = Math.abs(endAngle - startAngle);
  const full = sweep >= Math.PI * 2 - 1e-9;

  /** A whole circle, walked as two halves so neither arc is degenerate. */
  const circle = (r: number, clockwise: boolean): DrawPathCommand[] => {
    const start = at(startAngle, r);
    const half = at(startAngle + Math.PI, r);
    return [
      { op: "move", x: start.x, y: start.y },
      ...arcToCubics(start, r, r, 0, false, clockwise, half),
      ...arcToCubics(half, r, r, 0, false, clockwise, start),
      { op: "close" }
    ];
  };

  if (full) {
    // Opposite winding on the inner circle so the even-odd hole is correct on any
    // consumer that honours winding.
    return innerRadius > 0
      ? [...circle(radius, true), ...circle(innerRadius, false)]
      : circle(radius, true);
  }

  const outerFrom = at(startAngle, radius);
  const outerTo = at(endAngle, radius);
  const large = sweep > Math.PI;
  const clockwise = endAngle > startAngle;
  if (innerRadius > 0) {
    const innerTo = at(endAngle, innerRadius);
    const innerFrom = at(startAngle, innerRadius);
    return [
      { op: "move", x: outerFrom.x, y: outerFrom.y },
      ...arcToCubics(outerFrom, radius, radius, 0, large, clockwise, outerTo),
      { op: "line", x: innerTo.x, y: innerTo.y },
      ...arcToCubics(innerTo, innerRadius, innerRadius, 0, large, !clockwise, innerFrom),
      { op: "close" }
    ];
  }
  return [
    { op: "move", x: cx, y: cy },
    { op: "line", x: outerFrom.x, y: outerFrom.y },
    ...arcToCubics(outerFrom, radius, radius, 0, large, clockwise, outerTo),
    { op: "close" }
  ];
}

/** One contiguous run of a flattened path. */
export interface DrawSubpath {
  readonly points: readonly DrawPoint[];
  readonly closed: boolean;
}

/**
 * Flatten a path into straight-line subpaths.
 *
 * For backends that cannot consume a path at all — a `ChartPdfDrawingSurface`
 * without `drawPath`, a scanline rasteriser — and it has to preserve two things a
 * naive point-collector loses:
 *
 * - **Subpath boundaries.** A `move` starts a new run. Concatenating everything
 *   into one polyline draws a connector from the end of one ring to the start of
 *   the next, which on a region map is a line across the ocean between two
 *   islands.
 * - **Whether each run closed.** A `close` means the last point joins the first.
 *   Dropping it leaves every ring with a missing edge.
 *
 * Cubics are subdivided by control-polygon length so a large curve gets more
 * segments than a small one. `scale` is applied to the output points, letting a
 * supersampling backend ask for proportionally finer subdivision.
 */
export function flattenPath(commands: readonly DrawPathCommand[], scale = 1): DrawSubpath[] {
  const out: DrawSubpath[] = [];
  let current: DrawPoint[] = [];
  let cursor: DrawPoint = { x: 0, y: 0 };
  const flush = (closed: boolean): void => {
    if (current.length >= 2) {
      out.push({ points: current, closed });
    }
    current = [];
  };
  for (const command of commands) {
    switch (command.op) {
      case "move":
        flush(false);
        cursor = { x: command.x, y: command.y };
        current = [{ x: cursor.x * scale, y: cursor.y * scale }];
        break;
      case "line":
        cursor = { x: command.x, y: command.y };
        current.push({ x: cursor.x * scale, y: cursor.y * scale });
        break;
      case "cubic": {
        const span =
          Math.hypot(command.x1 - cursor.x, command.y1 - cursor.y) +
          Math.hypot(command.x2 - command.x1, command.y2 - command.y1) +
          Math.hypot(command.x - command.x2, command.y - command.y2);
        const steps = Math.max(4, Math.min(64, Math.ceil((span * scale) / 3)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          const px =
            u * u * u * cursor.x +
            3 * u * u * t * command.x1 +
            3 * u * t * t * command.x2 +
            t * t * t * command.x;
          const py =
            u * u * u * cursor.y +
            3 * u * u * t * command.y1 +
            3 * u * t * t * command.y2 +
            t * t * t * command.y;
          current.push({ x: px * scale, y: py * scale });
        }
        cursor = { x: command.x, y: command.y };
        break;
      }
      case "close":
        flush(true);
        break;
    }
  }
  flush(false);
  return out;
}

/** Kappa for approximating a quarter ellipse with one cubic. */
export const KAPPA = 0.5522847498307936;

/**
 * Lower a rounded rectangle to move / line / cubic / close.
 *
 * For backends whose rectangle primitive has no corner radius. The chart PDF
 * adapter draws onto a narrow surface whose `drawRect` takes no radius, so a
 * rounded panel came out square there while the SVG output rounded it — a
 * divergence the old renderer documented as unavoidable. It is avoidable whenever
 * the surface can take a path.
 *
 * `radius` is clamped to half the shorter side, as SVG does.
 */
export function roundedRectToPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): DrawPathCommand[] {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  if (r === 0) {
    return [
      { op: "move", x, y },
      { op: "line", x: x + width, y },
      { op: "line", x: x + width, y: y + height },
      { op: "line", x, y: y + height },
      { op: "close" }
    ];
  }
  const o = r * KAPPA;
  const right = x + width;
  const bottom = y + height;
  return [
    { op: "move", x: x + r, y },
    { op: "line", x: right - r, y },
    { op: "cubic", x1: right - r + o, y1: y, x2: right, y2: y + r - o, x: right, y: y + r },
    { op: "line", x: right, y: bottom - r },
    {
      op: "cubic",
      x1: right,
      y1: bottom - r + o,
      x2: right - r + o,
      y2: bottom,
      x: right - r,
      y: bottom
    },
    { op: "line", x: x + r, y: bottom },
    { op: "cubic", x1: x + r - o, y1: bottom, x2: x, y2: bottom - r + o, x, y: bottom - r },
    { op: "line", x, y: y + r },
    { op: "cubic", x1: x, y1: y + r - o, x2: x + r - o, y2: y, x: x + r, y },
    { op: "close" }
  ];
}

/** An axis-aligned box, in the terms every producer already describes one. */
export interface DrawBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A rect node from a box.
 *
 * Trivial, and that is the point: both chart producers had written it, against two
 * structurally identical box types, and a third would have written it again. The IR owns
 * `DrawNode`, so it owns the shorthand for building one.
 */
export function rectNode(box: DrawBox, paint: DrawPaint, rx?: number): DrawNode {
  return {
    kind: "rect",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    paint,
    ...(rx === undefined ? {} : { rx })
  };
}
