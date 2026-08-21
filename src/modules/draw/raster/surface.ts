/**
 * A {@link DrawSurface} that paints a display list into pixels.
 *
 * This replaces a string round trip. The Node PNG fallback used to take the SVG a
 * producer had just serialised and re-parse it with a regex scanner, which is why
 * it quietly disagreed with the other backends about dashes, opacity, rounded
 * corners and multi-line text — each was a separate attribute the scanner had
 * never been taught. Consuming the display list directly removes the whole class
 * of problem: there is nothing left to mis-parse.
 *
 * Curves are flattened here rather than by the walker, because a vector backend
 * would lose accuracy for nothing if the flattening happened upstream.
 */

import { BasicRasterCanvas } from "@draw/raster/canvas";
import { renderDrawList } from "@draw/render";
import type { DrawSurface } from "@draw/surface";
import { DEFAULT_TEXT_FAMILY, flattenPath, roundedRectToPath, sectorToPath } from "@draw/types";
import type { DrawClip, DrawList, DrawPaint, DrawPoint } from "@draw/types";
import type { Rgba01 } from "@utils/svg-lex";

/** Options for {@link rasterizeToRgba}. */
export interface RasterizeOptions {
  /** Output width in pixels. Defaults to the list's own width. */
  readonly width?: number;
  /** Output height in pixels. Defaults to the list's own height. */
  readonly height?: number;
  /** Device pixel ratio; values above 1 enlarge the output. Clamped to 8. */
  readonly scale?: number;
  /**
   * Anti-aliasing samples per axis. `1` disables it. Clamped to 4.
   *
   * The geometric primitives decide each pixel in or out — only glyphs carry
   * coverage — so a circle or a sloped line came out visibly stepped. Rendering at
   * `samples`× and averaging back down gives every primitive smooth edges at once,
   * including any added later, rather than teaching each one to compute coverage.
   */
  readonly samples?: number;
  /** Background fill. Omitted leaves the canvas transparent. */
  readonly background?: Rgba01;
}

/**
 * An 8-bit RGBA image, in the straight-alpha form a PNG encoder expects.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, row-major, straight (un-premultiplied) alpha. */
  readonly data: Uint8Array;
}

/**
 * Render a display list to pixels.
 *
 * Pixels rather than a PNG: a PNG is a *container*, and building one needs DEFLATE,
 * which lives a layer above this module. Keeping the boundary at the image means the
 * drawing engine stays free of a compression dependency and a caller can encode to
 * whatever it likes — `@excel/chart/render/draw-raster-png` is the thin adapter that
 * pairs this with the library's own PNG encoder.
 */
export function rasterizeToRgba(list: DrawList, options: RasterizeOptions = {}): RgbaImage {
  const width = Math.max(1, Math.round(options.width ?? list.width));
  const height = Math.max(1, Math.round(options.height ?? list.height));
  const scale = normalizeScale(options.scale);

  // Fit the list into the requested box uniformly, so a caller asking for a
  // different aspect gets a correct picture rather than a stretched one.
  const fit = Math.min(width / list.width, height / list.height);
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  if (pixelWidth * pixelHeight > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `raster output ${pixelWidth}x${pixelHeight} is ${Math.round(
        (pixelWidth * pixelHeight) / 1e6
      )}M pixels, over the ${Math.round(MAX_OUTPUT_PIXELS / 1e6)}M limit — ` +
        `reduce width/height or scale`
    );
  }
  const samples = normalizeSamples(options.samples, pixelWidth, pixelHeight);
  const canvas = new BasicRasterCanvas(pixelWidth * samples, pixelHeight * samples);
  if (options.background) {
    canvas.fillRect(0, 0, pixelWidth * samples, pixelHeight * samples, token(options.background));
  }
  renderDrawList(list, createRasterSurface(canvas, fit * scale * samples));
  return {
    width: pixelWidth,
    height: pixelHeight,
    data: samples === 1 ? canvas.data : downsample(canvas.data, pixelWidth, pixelHeight, samples)
  };
}

/**
 * Box-filter an RGBA buffer down by an integer factor.
 *
 * The buffer holds *straight* alpha, so the channels have to be weighted by alpha
 * before averaging and divided back out afterwards. Averaging straight alpha
 * directly pulls edge pixels towards whatever colour the transparent samples happen
 * to carry — usually black — which fringes every antialiased edge.
 *
 * Exported for testing: the weighting is the kind of arithmetic that looks right and
 * is wrong by a factor, and driving it through a render only shows the symptom.
 */
export function downsample(
  source: Uint8Array,
  width: number,
  height: number,
  factor: number
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const sourceWidth = width * factor;
  const total = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let alphaSum = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * sourceWidth;
        for (let dx = 0; dx < factor; dx++) {
          const index = (row + x * factor + dx) * 4;
          const alpha = source[index + 3];
          if (alpha === 0) {
            continue;
          }
          alphaSum += alpha;
          red += source[index] * alpha;
          green += source[index + 1] * alpha;
          blue += source[index + 2] * alpha;
        }
      }
      const target = (y * width + x) * 4;
      if (alphaSum === 0) {
        continue;
      }
      out[target] = Math.round(red / alphaSum);
      out[target + 1] = Math.round(green / alphaSum);
      out[target + 2] = Math.round(blue / alphaSum);
      out[target + 3] = Math.round(alphaSum / total);
    }
  }
  return out;
}

/**
 * The largest internal buffer the rasteriser will allocate, in pixels.
 *
 * At four bytes each that is 256 MB. Supersampling squares the buffer, so without a
 * ceiling a 1200x800 chart at `scale: 8` would ask for 28800x19200 — 2.2 GB — and
 * take the process down.
 */
const MAX_INTERNAL_PIXELS = 64_000_000;

/**
 * The largest image this rasteriser will produce, in pixels.
 *
 * Supersampling can be turned down to nothing, but the output buffer itself cannot: past
 * this size the request is refused rather than attempted. A 40000x40000 chart asks for
 * 6.4 GB of canvas before the PNG encoder has allocated anything, and the process is
 * killed rather than told what went wrong — which is the least useful way for a library
 * to fail. 64 M pixels is a 8000x8000 image, far beyond any chart, and the message names
 * the numbers so a caller can see what they asked for.
 */
const MAX_OUTPUT_PIXELS = 64_000_000;

/**
 * Clamp the anti-aliasing sample count to what fits in memory.
 *
 * Three steps per axis is nine coverage levels per pixel, which is enough for a
 * chart's curves and sloped lines to read as smooth, at nine times the fill cost of a
 * single sample.
 *
 * The ceiling is on the buffer rather than on `scale`, because that is where the risk
 * is: a small chart at a high device pixel ratio has room for full supersampling while
 * a large one has none, and a rule keyed to `scale` alone would either strip the
 * antialiasing from the first or blow up on the second.
 *
 * Exported so the decision can be asserted directly. Testing it through
 * {@link rasterizeDrawList} does not work: a machine with the memory to spare
 * completes the 2.2 GB render, slowly, and reports success either way.
 */
export function normalizeSamples(
  samples: number | undefined,
  pixelWidth: number,
  pixelHeight: number
): number {
  const requested = samples === undefined ? 3 : samples;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("raster samples must be a finite number >= 1");
  }
  let allowed = Math.max(1, Math.min(4, Math.floor(requested)));
  while (allowed > 1 && pixelWidth * allowed * pixelHeight * allowed > MAX_INTERNAL_PIXELS) {
    allowed--;
  }
  return allowed;
}

/**
 * Build a surface over an existing canvas.
 *
 * @param canvas - Target canvas.
 * @param scale - Factor from list user units to canvas pixels.
 */
export function createRasterSurface(canvas: BasicRasterCanvas, scale = 1): DrawSurface {
  const at = (value: number): number => value * scale;
  const points = (input: readonly DrawPoint[]): DrawPoint[] =>
    input.map(point => ({ x: at(point.x), y: at(point.y) }));

  return {
    pushClip(clip: DrawClip) {
      canvas.pushClip(at(clip.x), at(clip.y), at(clip.width), at(clip.height));
    },

    popClip() {
      canvas.popClip();
    },

    rect(x, y, width, height, rx, paint) {
      const fill = token(paint.fill);
      if (fill !== undefined) {
        if (rx > 0) {
          canvas.fillRoundRect(at(x), at(y), at(width), at(height), at(rx), fill);
        } else {
          canvas.fillRect(at(x), at(y), at(width), at(height), fill);
        }
      }
      const stroke = token(paint.stroke);
      if (stroke === undefined) {
        return;
      }
      if (rx > 0) {
        // `strokeRect` draws four straight edges and takes no radius, so a rounded
        // panel came out with a rounded fill inside a square outline. Trace the same
        // lowering the other backends use.
        for (const subpath of flattenPath(roundedRectToPath(x, y, width, height, rx), scale)) {
          canvas.drawPolyline(
            subpath.closed ? [...subpath.points, subpath.points[0]] : [...subpath.points],
            stroke,
            strokeWidth(paint, scale),
            paint.dash?.map(part => part * scale),
            strokeShape(paint, subpath.closed)
          );
        }
        return;
      }
      // Stroke it as a closed polyline rather than four separate lines. `strokeRect`
      // stamps a square brush along each edge, so the same pixel is composited many
      // times over and a half-transparent outline saturated to opaque — every other
      // primitive already went through the polyline path and came out right.
      canvas.drawPolyline(
        [
          { x: at(x), y: at(y) },
          { x: at(x + width), y: at(y) },
          { x: at(x + width), y: at(y + height) },
          { x: at(x), y: at(y + height) },
          { x: at(x), y: at(y) }
        ],
        stroke,
        strokeWidth(paint, scale),
        paint.dash?.map(part => part * scale),
        strokeShape(paint, true)
      );
    },

    ellipse(cx, cy, rx, ry, paint) {
      const fill = token(paint.fill);
      if (fill !== undefined) {
        canvas.fillEllipse(at(cx), at(cy), at(rx), at(ry), fill);
      }
      const stroke = token(paint.stroke);
      if (stroke !== undefined) {
        canvas.strokeEllipse(
          at(cx),
          at(cy),
          at(rx),
          at(ry),
          stroke,
          strokeWidth(paint, scale),
          paint.dash?.map(part => part * scale),
          // A closed outline: its first and last vertex is a corner like any other.
          strokeShape(paint, true)
        );
      }
    },

    sector(cx, cy, radius, innerRadius, startAngle, endAngle, paint) {
      const fill = token(paint.fill);
      if (fill !== undefined) {
        // Per-pixel radius and angle test: an exact edge, no polygon facets. This
        // is what the old `data-sector` attribute existed to reach.
        canvas.fillSector(at(cx), at(cy), at(radius), at(innerRadius), startAngle, endAngle, fill);
      }
      const stroke = token(paint.stroke);
      if (stroke === undefined) {
        return;
      }
      // The fill is exact but it cannot carry an outline, and a pie slice's
      // separator is a stroke: filling only meant a pie or sunburst kept its white
      // dividers in SVG and PDF and lost them in a PNG. Trace the same lowering the
      // PDF adapter uses, so all three agree on where the edge is.
      for (const subpath of flattenPath(
        sectorToPath(cx, cy, radius, innerRadius, startAngle, endAngle),
        scale
      )) {
        canvas.drawPolyline(
          subpath.closed ? [...subpath.points, subpath.points[0]] : [...subpath.points],
          stroke,
          strokeWidth(paint, scale),
          paint.dash?.map(part => part * scale),
          strokeShape(paint, subpath.closed)
        );
      }
    },

    polyline(input, closed, paint) {
      paintPolygon(canvas, points(input), closed, paint, scale);
    },

    path(commands, paint) {
      const subpaths = flattenPath(commands, scale);
      const fill = token(paint.fill);
      if (fill !== undefined) {
        // Every closed ring resolved together, under the requested winding rule. Filling
        // subpath by subpath paints a hole back in — a country's lake, a ring's middle —
        // and pairing crossings two at a time is even-odd whatever was asked for.
        canvas.fillRings(
          subpaths.filter(subpath => subpath.closed).map(subpath => [...subpath.points]),
          fill,
          paint.fillRule ?? "nonzero"
        );
      }
      const stroke = token(paint.stroke);
      if (stroke === undefined) {
        return;
      }
      // The outline is per subpath: a stroke follows each ring separately, and joining
      // them would draw a line between the two.
      for (const subpath of subpaths) {
        canvas.drawPolyline(
          subpath.closed ? [...subpath.points, subpath.points[0]] : [...subpath.points],
          stroke,
          strokeWidth(paint, scale),
          paint.dash?.map(part => part * scale),
          strokeShape(paint, subpath.closed)
        );
      }
    },

    text(x, y, lines, style, rotate) {
      const fill = token(style.fill);
      if (fill === undefined) {
        return;
      }
      for (const line of lines) {
        if (line.text === "") {
          continue;
        }
        canvas.drawText(
          at(line.x ?? x),
          at(y + line.dy),
          line.text,
          at(style.size),
          fill,
          style.anchor ?? "start",
          rotate === 0 ? undefined : { angle: rotate, originX: at(x), originY: at(y) },
          {
            family: style.family ?? DEFAULT_TEXT_FAMILY,
            ...(style.bold === undefined ? {} : { bold: style.bold }),
            ...(style.italic === undefined ? {} : { italic: style.italic })
          }
        );
      }
    }
  };
}

/** Fill and/or stroke one closed or open run of points. */
function paintPolygon(
  canvas: BasicRasterCanvas,
  points: readonly DrawPoint[],
  closed: boolean,
  paint: DrawPaint,
  scale: number
): void {
  if (points.length < 2) {
    return;
  }
  const fill = token(paint.fill);
  if (closed && fill !== undefined) {
    canvas.fillPolygon([...points], fill);
  }
  const stroke = token(paint.stroke);
  if (stroke !== undefined) {
    canvas.drawPolyline(
      closed ? [...points, points[0]] : [...points],
      stroke,
      strokeWidth(paint, scale),
      paint.dash?.map(part => part * scale),
      strokeShape(paint, closed)
    );
  }
}

/**
 * The join and cap the canvas should apply.
 *
 * A closed run has no ends, so its first and last vertex is a corner like any other
 * and a round *join* has to round it — asking for a cap there would leave the seam
 * notched.
 */
function strokeShape(
  paint: DrawPaint,
  closed: boolean
): { join?: "miter" | "round" | "bevel"; cap?: "butt" | "round" | "square" } {
  return {
    ...(paint.lineJoin === undefined ? {} : { join: paint.lineJoin }),
    ...(closed
      ? paint.lineJoin === "round"
        ? { cap: "round" as const }
        : {}
      : paint.lineCap === undefined
        ? {}
        : { cap: paint.lineCap })
  };
}

/** Stroke width in canvas pixels, defaulting to a hairline. */
function strokeWidth(paint: DrawPaint, scale: number): number {
  return Math.max(1, (paint.strokeWidth ?? 1) * scale);
}

/**
 * Encode a colour as a `#rrggbbaa` token.
 *
 * The canvas primitives take a colour *string*, so folding alpha into the token
 * keeps their signatures untouched while still compositing correctly.
 */
function token(colour: Rgba01 | undefined): string | undefined {
  if (!colour) {
    return undefined;
  }
  const channel = (component: number): string =>
    Math.max(0, Math.min(255, Math.round(component * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}${channel(colour.a)}`;
}

/** Clamp the supersampling factor. */
function normalizeScale(scale: number | undefined): number {
  if (scale === undefined) {
    return 1;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("raster scale must be a positive finite number");
  }
  return Math.min(8, scale);
}
