/**
 * A recording {@link ChartPdfDrawingSurface}, for proving two chart PDF
 * renderers issue the same drawing.
 *
 * Same reasoning as `svg-geometry.ts`: a hash over the renderer's own diagnostic
 * `trace` strings cannot survive a re-implementation, so the only way past a
 * broken one is to re-baseline it against the new output. Describing the *calls*
 * — primitive, coordinates, paint — compares the drawing instead of the wording.
 *
 * Intended for tests only.
 */

/** Round so formatting differences do not register. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Colourish {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** `#rrggbb`, plus `@a` when not opaque. */
function colour(value: Colourish | undefined): string {
  if (!value) {
    return "-";
  }
  const channel = (component: number): string =>
    Math.max(0, Math.min(255, Math.round(component * 255)))
      .toString(16)
      .padStart(2, "0");
  const hex = `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`;
  return value.a === undefined || value.a >= 1 ? hex : `${hex}@${round(value.a)}`;
}

/**
 * One recorded primitive, in the shape {@link SvgShape} uses.
 *
 * Lets a test compare what a PDF surface was asked to draw against what the SVG
 * backend emitted, rather than comparing two hashes that can drift apart
 * independently.
 */
export interface PdfShape {
  readonly kind: string;
  readonly coords: readonly number[];
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly text?: string;
}

/** A surface that records every call in a stable, diffable form. */
export function recordChartPdf() {
  const calls: string[] = [];
  const shapes: PdfShape[] = [];
  const paint = (
    fill: Colourish | undefined,
    stroke: Colourish | undefined,
    lineWidth?: number
  ): Pick<PdfShape, "fill" | "stroke" | "strokeWidth"> => ({
    ...(fill ? { fill: colour(fill) } : {}),
    ...(stroke ? { stroke: colour(stroke), strokeWidth: round(lineWidth ?? 1) } : {})
  });
  const surface = {
    drawRect(options: {
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: Colourish;
      stroke?: Colourish;
      lineWidth?: number;
    }) {
      calls.push(
        `rect ${round(options.x)},${round(options.y)} ${round(options.width)}x${round(options.height)} ` +
          `f=${colour(options.fill)} s=${colour(options.stroke)}`
      );
      shapes.push({
        kind: "rect",
        coords: [round(options.x), round(options.y), round(options.width), round(options.height)],
        ...paint(options.fill, options.stroke, options.lineWidth)
      });
      return surface;
    },
    drawLine(options: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: Colourish;
      lineWidth?: number;
      dashPattern?: number[];
    }) {
      calls.push(
        `line ${round(options.x1)},${round(options.y1)}→${round(options.x2)},${round(options.y2)} ` +
          `c=${colour(options.color)} w=${round(options.lineWidth ?? 1)}` +
          (options.dashPattern ? ` d=${options.dashPattern.map(round).join("/")}` : "")
      );
      shapes.push({
        kind: "line",
        coords: [round(options.x1), round(options.y1), round(options.x2), round(options.y2)],
        ...paint(undefined, options.color, options.lineWidth)
      });
      return surface;
    },
    drawText(
      text: string,
      options: {
        x: number;
        y: number;
        fontSize?: number;
        color?: Colourish;
        rotation?: number;
        anchor?: string;
      }
    ) {
      calls.push(
        `text ${round(options.x)},${round(options.y)} "${text}" ` +
          `sz=${round(options.fontSize ?? 0)} c=${colour(options.color)} ` +
          `a=${options.anchor ?? "start"} rot=${round(options.rotation ?? 0)}`
      );
      shapes.push({
        kind: "text",
        coords: [round(options.x), round(options.y)],
        text,
        ...(options.color ? { fill: colour(options.color) } : {})
      });
      return surface;
    },
    drawCircle(options: {
      cx: number;
      cy: number;
      r: number;
      fill?: Colourish;
      stroke?: Colourish;
    }) {
      calls.push(
        `circle ${round(options.cx)},${round(options.cy)} r=${round(options.r)} ` +
          `f=${colour(options.fill)} s=${colour(options.stroke)}`
      );
      shapes.push({
        kind: "circle",
        coords: [round(options.cx), round(options.cy), round(options.r)],
        ...paint(options.fill, options.stroke)
      });
      return surface;
    },
    drawPath(
      ops: {
        op: string;
        x?: number;
        y?: number;
        x1?: number;
        y1?: number;
        x3?: number;
        y3?: number;
      }[],
      options?: { fill?: Colourish; stroke?: Colourish; closePath?: boolean }
    ) {
      const shape = ops
        .map(op => {
          switch (op.op) {
            case "move":
              return `M${round(op.x ?? 0)},${round(op.y ?? 0)}`;
            case "line":
              return `L${round(op.x ?? 0)},${round(op.y ?? 0)}`;
            case "curve":
              return `C${round(op.x3 ?? 0)},${round(op.y3 ?? 0)}`;
            default:
              return "Z";
          }
        })
        .join(" ");
      calls.push(`path ${shape} f=${colour(options?.fill)} s=${colour(options?.stroke)}`);
      const coords: number[] = [];
      for (const op of ops) {
        if (op.op === "close") {
          continue;
        }
        coords.push(round(op.x3 ?? op.x ?? 0), round(op.y3 ?? op.y ?? 0));
      }
      // A path of nothing but moves and lines is a polyline — or a polygon when it
      // closes. Reporting it as such is the same normalisation `svg-geometry.ts`
      // applies to an `M`/`L`-only `d`, so a shape the SVG backend emits as
      // `<polygon>` and this one draws as a path are not recorded as different
      // things.
      const curved = ops.some(op => op.op === "curve");
      const closed = ops.some(op => op.op === "close");
      shapes.push({
        kind: curved ? "path" : closed ? "polygon" : "polyline",
        coords,
        ...paint(options?.fill, options?.stroke)
      });
      return surface;
    }
  };
  return { surface, calls, shapes, describe: (): string => calls.join("\n") };
}
