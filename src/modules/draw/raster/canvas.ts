/**
 * A minimal software rasteriser: an RGBA pixel buffer with the primitives the
 * shared drawing engine's raster surface needs.
 *
 * Lives in its own file because it belongs to neither renderer. It used to sit
 * inside `chart-renderer.ts`, which made the raster surface import the chart
 * renderer and the chart renderer import the raster surface — a cycle the repo
 * forbids, and a sign the class was in the wrong place: nothing here knows what a
 * chart is.
 *
 * Compositing is non-premultiplied source-over, and clipping is a scissor test
 * inside `setPixel` so every primitive — including glyph coverage — is bounded by
 * it without each one needing its own check.
 */

import type { RasterFont } from "@draw/raster/glyph-rasterizer";
import { loadSystemFont, rasterizeGlyph } from "@draw/raster/glyph-rasterizer";
import { STROKE_FONT } from "@draw/raster/stroke-font";
import { measureText } from "@draw/text";
import { DEFAULT_TEXT_FAMILY } from "@draw/types";
import { parseCssColor } from "@utils/svg-lex";

/** A glyph rasterised to a coverage bitmap. */
type RasterizedGlyph = {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pixels: Uint8Array;
};

/**
 * Cache rasterised glyphs so repeated text at one size is rasterised once. Keyed
 * by the outline reference (stable per font and code point) and the font size.
 */
const glyphCache = new WeakMap<object, Map<number, RasterizedGlyph>>();

function cachedRasterizeGlyph(
  outline: object & { contours: unknown[]; advanceWidth: number },
  fontSize: number,
  unitsPerEm: number
): RasterizedGlyph {
  let sizeMap = glyphCache.get(outline);
  if (!sizeMap) {
    sizeMap = new Map();
    glyphCache.set(outline, sizeMap);
  }
  let cached = sizeMap.get(fontSize);
  if (!cached) {
    cached = rasterizeGlyph(outline as Parameters<typeof rasterizeGlyph>[0], fontSize, unitsPerEm);
    sizeMap.set(fontSize, cached);
  }
  return cached;
}

/** A point in raster space. */
export interface RasterPoint {
  x: number;
  y: number;
}

/** Clamp an integer into `[min, max]`. */
function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Resolve a colour token to 8-bit RGBA.
 *
 * Accepts everything CSS does via the shared lexer, including the `#rrggbbaa`
 * form the raster surface uses to fold opacity into a single token.
 */
function parseSvgColor(color: string | undefined): [number, number, number, number] | undefined {
  const parsed = parseCssColor(color);
  if (!parsed) {
    return undefined;
  }
  return [
    Math.round(parsed.r * 255),
    Math.round(parsed.g * 255),
    Math.round(parsed.b * 255),
    Math.round(parsed.a * 255)
  ];
}

export class BasicRasterCanvas {
  readonly data: Uint8Array;

  /**
   * Coverage accumulator used by {@link withCoverage}; `undefined` when inactive, in
   * which case {@link setPixel} composites normally.
   */
  private mask: Uint8Array | undefined;
  private maskAlpha = 0;
  private maskX0 = 0;
  private maskY0 = 0;
  private maskX1 = 0;
  private maskY1 = 0;
  /**
   * Scissor stack. Every primitive funnels through `setPixel`, so enforcing the
   * clip there covers all of them at once — including glyph coverage, which a
   * per-primitive bounds check would miss.
   */
  private readonly clips: { x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  /**
   * Fill a rounded rectangle.
   *
   * `rx` was ignored on this path, so the ChartEx region-map frame rasterised
   * with square corners while the SVG and browser-PNG backends rounded them.
   */
  fillRoundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: string | undefined
  ): void {
    const r = Math.min(radius, width / 2, height / 2);
    if (!(r > 0)) {
      this.fillRect(x, y, width, height, color);
      return;
    }
    // Straight middle band, then the two end bands scanline by scanline so the
    // corner arcs are exact rather than approximated by a polygon.
    this.fillRect(x, y + r, width, height - 2 * r, color);
    for (let dy = 0; dy < r; dy++) {
      const inset = r - Math.sqrt(Math.max(0, r * r - (r - dy - 0.5) * (r - dy - 0.5)));
      const runX = x + inset;
      const runWidth = width - 2 * inset;
      this.fillRect(runX, y + dy, runWidth, 1, color);
      this.fillRect(runX, y + height - dy - 1, runWidth, 1, color);
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || width <= 0 || height <= 0) {
      return;
    }
    const x0 = clampInt(Math.floor(x), 0, this.width);
    const y0 = clampInt(Math.floor(y), 0, this.height);
    const x1 = clampInt(Math.ceil(x + width), 0, this.width);
    const y1 = clampInt(Math.ceil(y + height), 0, this.height);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        this.setPixel(xx, yy, rgba);
      }
    }
  }

  strokeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: string | undefined,
    strokeWidth = 1
  ): void {
    this.drawLine(x, y, x + width, y, color, strokeWidth);
    this.drawLine(x + width, y, x + width, y + height, color, strokeWidth);
    this.drawLine(x + width, y + height, x, y + height, color, strokeWidth);
    this.drawLine(x, y + height, x, y, color, strokeWidth);
  }

  drawPolyline(
    points: RasterPoint[],
    color: string | undefined,
    width = 1,
    dash?: readonly number[],
    shape: { join?: "miter" | "round" | "bevel"; cap?: "butt" | "round" | "square" } = {}
  ): void {
    if (points.length < 2) {
      return;
    }
    if (dash && dash.length > 0) {
      // One dash phase walked across the whole polyline, so the pattern does not
      // restart at every vertex.
      //
      // Each dash is a stroke of its own and carries the requested cap at both of its
      // ends: a dashed line with round caps is a row of lozenges, not of rectangles.
      // Hard-coding butt made the three cap settings indistinguishable, while SVG and PDF
      // shaped every dash.
      let phase = 0;
      for (let i = 1; i < points.length; i++) {
        phase = this.drawDashedSegment(
          points[i - 1],
          points[i],
          color,
          width,
          dash,
          phase,
          shape.cap ?? "butt"
        );
      }
      return;
    }
    const radius = width / 2;
    if (radius <= 0.5) {
      // A hairline has no outline to speak of; the supersampled Bresenham run is
      // both cheaper and smoother than a one-pixel-wide polygon.
      for (let i = 1; i < points.length; i++) {
        this.drawLine(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, color, width);
      }
      return;
    }
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }
    // Fill the stroke's outline rather than stamping a square brush along it. The
    // brush made every end a square cap half a width too long — `butt` was
    // unreachable — and turned a thick stroke's edge into a staircase of blocks.
    //
    // All of it inside one coverage pass: the pieces overlap at every joint, and
    // compositing them one by one darkened a translucent stroke there.
    const cap = shape.cap ?? "butt";
    this.withCoverage(rgba, () => {
      for (let i = 1; i < points.length; i++) {
        this.fillSegment(points[i - 1], points[i], radius, color, {
          start: i === 1 ? cap : "butt",
          end: i === points.length - 1 ? cap : "butt"
        });
      }
      // Butt-ended segments leave a notch on the outside of each corner. A disc of
      // the stroke's own radius is exactly a round join; a triangle across the gap is
      // a bevel, which is what `miter` degrades to here — the spike needs the
      // segments' directions and nothing asks for it.
      const join = shape.join ?? "miter";
      for (let i = 1; i < points.length - 1; i++) {
        if (join === "round") {
          this.fillEllipse(points[i].x, points[i].y, radius, radius, color);
          continue;
        }
        this.fillJoinBevel(points[i - 1], points[i], points[i + 1], radius, color);
        if (join === "miter") {
          this.fillJoinMiter(points[i - 1], points[i], points[i + 1], radius, color);
        }
      }
    });
  }

  /** Fill one segment of a thick stroke, including its end shapes. */
  private fillSegment(
    from: RasterPoint,
    to: RasterPoint,
    radius: number,
    color: string | undefined,
    caps: { start: "butt" | "round" | "square"; end: "butt" | "round" | "square" }
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      if (caps.start === "round" || caps.end === "round") {
        this.fillEllipse(from.x, from.y, radius, radius, color);
      }
      return;
    }
    const ux = dx / length;
    const uy = dy / length;
    // Normal to the segment, scaled to half the stroke width.
    const nx = -uy * radius;
    const ny = ux * radius;
    // A square cap extends the body by the radius; a round one is a disc added below.
    const startExtend = caps.start === "square" ? radius : 0;
    const endExtend = caps.end === "square" ? radius : 0;
    const ax = from.x - ux * startExtend;
    const ay = from.y - uy * startExtend;
    const bx = to.x + ux * endExtend;
    const by = to.y + uy * endExtend;
    this.fillPolygon(
      [
        { x: ax + nx, y: ay + ny },
        { x: bx + nx, y: by + ny },
        { x: bx - nx, y: by - ny },
        { x: ax - nx, y: ay - ny }
      ],
      color
    );
    if (caps.start === "round") {
      this.fillEllipse(from.x, from.y, radius, radius, color);
    }
    if (caps.end === "round") {
      this.fillEllipse(to.x, to.y, radius, radius, color);
    }
  }

  /**
   * Extend a corner to the point where its two outer edges meet.
   *
   * The bevel wedge fills the notch; a miter adds the spike beyond it, which is the
   * default in both SVG and PDF. Without this the rasteriser drew every sharp corner
   * bevelled while the other two backends came to a point — visible on any line chart
   * with a peak.
   *
   * Past the miter limit the spike is dropped and the bevel stands, which is what the
   * limit is for: at a very sharp angle the intersection runs away to infinity, and SVG's
   * default limit of 4 cuts it off at four times the stroke's half-width.
   */
  private fillJoinMiter(
    previous: RasterPoint,
    corner: RasterPoint,
    next: RasterPoint,
    radius: number,
    color: string | undefined
  ): void {
    const unit = (from: RasterPoint, to: RasterPoint): RasterPoint | undefined => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      return length === 0 ? undefined : { x: dx / length, y: dy / length };
    };
    const incoming = unit(previous, corner);
    const outgoing = unit(corner, next);
    if (!incoming || !outgoing) {
      return;
    }
    // The bisector of the outer angle. A straight-through or fully doubled-back corner
    // has none, and neither needs a spike.
    const bisectorX = incoming.x - outgoing.x;
    const bisectorY = incoming.y - outgoing.y;
    const bisectorLength = Math.hypot(bisectorX, bisectorY);
    if (bisectorLength < 1e-9) {
      return;
    }
    // The interior angle between the two edges, which is what the miter length depends on.
    //
    // `atan2(|cross|, dot)` on the two *direction* vectors gives the angle between them —
    // the turn, zero for a straight line. The interior angle of the corner is its
    // supplement, so `sin(interior / 2)` is `cos(turn / 2)`. Subtracting the turn from a
    // right angle as well took the supplement twice: `sinHalf` then sat near 1 for every
    // corner, the miter length came out equal to the radius, and both the spike and the
    // limit did nothing at all.
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const turn = Math.atan2(Math.abs(cross), dot);
    const sinHalfInterior = Math.cos(turn / 2);
    if (sinHalfInterior < 1e-9) {
      return;
    }
    const miterLength = radius / sinHalfInterior;
    // SVG's default limit of 4, measured as the spec measures it: miter length against the
    // *stroke width*, not against its half. Comparing to the radius made the limit
    // effectively 2, so corners were bevelled while SVG and PDF still mitred them.
    if (miterLength / (radius * 2) > 4) {
      return;
    }
    const tipX = corner.x + (bisectorX / bisectorLength) * miterLength;
    const tipY = corner.y + (bisectorY / bisectorLength) * miterLength;
    // The spike is the triangle from each edge's outer offset to the tip. Which side is
    // outer depends on the turn, so fill both; the inner one lands inside the stroke.
    const normal = (direction: RasterPoint, sign: number): RasterPoint => ({
      x: corner.x + -direction.y * radius * sign,
      y: corner.y + direction.x * radius * sign
    });
    for (const sign of [1, -1]) {
      this.fillPolygon(
        [normal(incoming, sign), { x: tipX, y: tipY }, normal(outgoing, sign)],
        color
      );
    }
  }

  /** Fill the wedge left open on the outside of a corner. */
  private fillJoinBevel(
    previous: RasterPoint,
    corner: RasterPoint,
    next: RasterPoint,
    radius: number,
    color: string | undefined
  ): void {
    const offset = (from: RasterPoint, to: RasterPoint): RasterPoint | undefined => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      return length === 0 ? undefined : { x: (-dy / length) * radius, y: (dx / length) * radius };
    };
    const incoming = offset(previous, corner);
    const outgoing = offset(corner, next);
    if (!incoming || !outgoing) {
      return;
    }
    // Both sides of the corner, so the outer one is covered whichever way it turns.
    for (const sign of [1, -1]) {
      this.fillPolygon(
        [
          { x: corner.x + incoming.x * sign, y: corner.y + incoming.y * sign },
          { x: corner.x + outgoing.x * sign, y: corner.y + outgoing.y * sign },
          { x: corner.x, y: corner.y }
        ],
        color
      );
    }
  }

  /**
   * Draw one segment of a dashed stroke and return the advanced dash phase.
   *
   * `stroke-dasharray` was parsed nowhere on this path, so a waterfall
   * connector, a box-whisker mean line and a classic dashed trendline all
   * rasterised solid while the SVG and browser-PNG backends drew them dashed.
   */
  private drawDashedSegment(
    from: RasterPoint,
    to: RasterPoint,
    color: string | undefined,
    width: number,
    dash: readonly number[],
    startPhase: number,
    cap: "butt" | "round" | "square" = "butt"
  ): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      return startPhase;
    }
    const period = dash.reduce((sum, part) => sum + part, 0);
    if (period <= 0) {
      this.drawLine(from.x, from.y, to.x, to.y, color, width);
      return startPhase;
    }
    const dashRgba = parseSvgColor(color);
    if (!dashRgba) {
      return startPhase;
    }
    const ux = dx / length;
    const uy = dy / length;
    let phase = startPhase % period;
    let travelled = 0;
    // `dash` alternates on/off starting with "on"; an odd-length array repeats,
    // which the modulo indexing below handles naturally.
    let index = 0;
    let remaining = dash[0];
    // Fast-forward into the pattern so the phase carries across segments.
    while (phase > 0) {
      const step = Math.min(phase, remaining);
      remaining -= step;
      phase -= step;
      if (remaining <= 0) {
        index = (index + 1) % dash.length;
        remaining = dash[index];
      }
    }
    const radius = width / 2;
    while (travelled < length) {
      const step = Math.min(remaining, length - travelled);
      if (index % 2 === 0 && step > 0) {
        const a = { x: from.x + ux * travelled, y: from.y + uy * travelled };
        const b = { x: from.x + ux * (travelled + step), y: from.y + uy * (travelled + step) };
        if (radius <= 0.5) {
          this.drawLine(a.x, a.y, b.x, b.y, color, width);
        } else {
          // Fill each dash's outline, like a solid stroke. Stamping a square brush
          // extended every dash by half the stroke width at both ends, so a 12-wide
          // `[10, 6]` pattern drew 22-long dashes across 6-long gaps and came out
          // solid — the dashes were there, just overlapping.
          this.fillSegment(a, b, radius, color, { start: cap, end: cap });
        }
      }
      travelled += step;
      remaining -= step;
      if (remaining <= 0) {
        index = (index + 1) % dash.length;
        remaining = dash[index];
      }
    }
    return startPhase + length;
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string | undefined,
    width = 1
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }
    let x0 = Math.round(x1);
    let y0 = Math.round(y1);
    const xEnd = Math.round(x2);
    const yEnd = Math.round(y2);
    const dx = Math.abs(xEnd - x0);
    const sx = x0 < xEnd ? 1 : -1;
    const dy = -Math.abs(yEnd - y0);
    const sy = y0 < yEnd ? 1 : -1;
    let err = dx + dy;
    const radius = Math.max(0, Math.floor(width / 2));
    while (true) {
      for (let yy = y0 - radius; yy <= y0 + radius; yy++) {
        for (let xx = x0 - radius; xx <= x0 + radius; xx++) {
          this.setPixel(xx, yy, rgba);
        }
      }
      if (x0 === xEnd && y0 === yEnd) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || r <= 0) {
      return;
    }
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    const rr = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rr) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  /**
   * Fill an axis-aligned ellipse.
   *
   * The canvas only had circles, so the shared drawing engine's raster surface
   * had to approximate a non-circular ellipse with a 64-gon — visibly faceted at
   * any real size. A per-pixel normalised-radius test is the same cost as
   * `fillCircle` and exact.
   */
  fillEllipse(cx: number, cy: number, rx: number, ry: number, color: string | undefined): void {
    const rgba = parseSvgColor(color);
    if (!rgba || rx <= 0 || ry <= 0) {
      return;
    }
    const y0 = Math.floor(cy - ry);
    const y1 = Math.ceil(cy + ry);
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      const nySq = ny * ny;
      if (nySq > 1) {
        continue;
      }
      // Solve the ellipse equation for x instead of testing every pixel, so a
      // wide ellipse costs its own area rather than its bounding box.
      const span = rx * Math.sqrt(1 - nySq);
      const from = Math.ceil(cx - span);
      const to = Math.floor(cx + span);
      for (let x = from; x <= to; x++) {
        this.setPixel(x, y, rgba);
      }
    }
  }

  /** Stroke an axis-aligned ellipse. */
  strokeEllipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    color: string | undefined,
    width = 1,
    dash?: readonly number[],
    shape: { join?: "miter" | "round" | "bevel"; cap?: "butt" | "round" | "square" } = {}
  ): void {
    const points: RasterPoint[] = [];
    const steps = Math.max(16, Math.ceil((rx + ry) * 1.5));
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    }
    // The outline is already a closed loop of points, so the dash phase and the join
    // travel with it exactly as they do for any other traced primitive. Not passing
    // them is why a dashed ellipse came out solid while SVG dashed it.
    this.drawPolyline(points, color, width, dash, shape);
  }

  strokeCircle(cx: number, cy: number, r: number, color: string | undefined, width = 1): void {
    const points: RasterPoint[] = [];
    const steps = Math.max(12, Math.ceil(r * 2));
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    this.drawPolyline(points, color, width);
  }

  /**
   * Fill a circular sector (pie slice) with pixel-level precision.
   * Uses distance + angle tests per pixel instead of polygon scanline,
   * producing smooth circular edges without polygon approximation artifacts.
   */
  fillSector(
    cx: number,
    cy: number,
    outerR: number,
    innerR: number,
    startAngle: number,
    endAngle: number,
    color: string | undefined
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba || outerR <= 0) {
      return;
    }
    const x0 = clampInt(Math.floor(cx - outerR), 0, this.width);
    const x1 = clampInt(Math.ceil(cx + outerR), 0, this.width);
    const y0 = clampInt(Math.floor(cy - outerR), 0, this.height);
    const y1 = clampInt(Math.ceil(cy + outerR), 0, this.height);
    const outerRR = outerR * outerR;
    const innerRR = innerR * innerR;
    // A full sweep has to bypass the angle test entirely. Normalising `2π` gives
    // `0`, so `start === end` and only the pixels lying exactly on 0 rad pass —
    // i.e. a whole disc rendered as nothing. Unreachable while the pie emitter
    // special-cased a full slice into a `<circle>`, but the shared drawing engine
    // hands sectors here verbatim.
    const fullSweep = Math.abs(endAngle - startAngle) >= Math.PI * 2 - 1e-9;
    // Normalise angles to [0, 2π)
    let sa = startAngle % (Math.PI * 2);
    if (sa < 0) {
      sa += Math.PI * 2;
    }
    let ea = endAngle % (Math.PI * 2);
    if (ea < 0) {
      ea += Math.PI * 2;
    }
    const crossesZero = ea < sa;
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > outerRR || dist2 < innerRR) {
          continue;
        }
        let angle = Math.atan2(dy, dx);
        if (angle < 0) {
          angle += Math.PI * 2;
        }
        const inAngle =
          fullSweep || (crossesZero ? angle >= sa || angle <= ea : angle >= sa && angle <= ea);
        if (inAngle) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  fillPolygon(points: RasterPoint[], color: string | undefined): void {
    this.fillRings([points], color, "nonzero");
  }

  /**
   * Fill a set of closed rings as one shape, honouring a winding rule.
   *
   * A compound path — a country with a lake, a glyph with a counter, a ring — is several
   * rings that have to be resolved *together*: whether a pixel is inside depends on how
   * many edges of the whole shape lie to its left and which way each is wound. Filling
   * ring by ring paints the hole back in, and pairing crossings two at a time is
   * even-odd whatever the caller asked for.
   *
   * Scanline, with the crossings sorted once and then walked while a counter tracks the
   * winding. `evenodd` flips on every edge; `nonzero` counts direction and is inside
   * wherever the sum is not zero.
   */
  fillRings(
    rings: readonly RasterPoint[][],
    color: string | undefined,
    fillRule: "nonzero" | "evenodd"
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }
    const usable = rings.filter(ring => ring.length >= 3);
    if (usable.length === 0) {
      return;
    }
    let minYRaw = usable[0][0].y;
    let maxYRaw = usable[0][0].y;
    for (const ring of usable) {
      for (const point of ring) {
        if (point.y < minYRaw) {
          minYRaw = point.y;
        }
        if (point.y > maxYRaw) {
          maxYRaw = point.y;
        }
      }
    }
    const minY = clampInt(Math.floor(minYRaw), 0, this.height - 1);
    const maxY = clampInt(Math.ceil(maxYRaw), 0, this.height - 1);
    for (let y = minY; y <= maxY; y++) {
      // `direction` is +1 for an edge crossing downwards and -1 upwards, which is what
      // the nonzero rule counts. Even-odd ignores it.
      const crossings: Array<{ x: number; direction: number }> = [];
      for (const ring of usable) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i];
          const b = ring[j];
          if (a.y > y !== b.y > y) {
            crossings.push({
              x: ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x,
              direction: b.y > a.y ? 1 : -1
            });
          }
        }
      }
      if (crossings.length < 2) {
        continue;
      }
      crossings.sort((left, right) => left.x - right.x);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        winding += fillRule === "evenodd" ? 1 : crossings[i].direction;
        const inside = fillRule === "evenodd" ? winding % 2 !== 0 : winding !== 0;
        if (!inside) {
          continue;
        }
        // Half-open in x: the pixel a span ends on is the one the next span begins on, so
        // covering both ends composited that column twice. Invisible while the paint is
        // opaque, a darker seam as soon as it is not — the same mistake the stroke pieces
        // used to make at their joints.
        const x0 = clampInt(Math.round(crossings[i].x), 0, this.width);
        const x1 = clampInt(Math.round(crossings[i + 1].x), 0, this.width);
        for (let x = x0; x < x1; x++) {
          this.setPixel(x, y, rgba);
        }
      }
    }
  }

  drawText(
    x: number,
    y: number,
    text: string,
    fontSize: number,
    color: string | undefined,
    anchor: string | undefined,
    rotation?: { angle: number; originX: number; originY: number },
    style: { family?: string; bold?: boolean; italic?: boolean } = {}
  ): void {
    if (!text) {
      return;
    }
    // Measure with the style the caller asked for, not with the default face.
    //
    // The glyphs themselves come from one system font — selecting a family, a weight and
    // a slant means font discovery and matching, which this rasteriser does not do — but
    // the *width* has to follow the requested style regardless, because it decides where
    // centred and right-anchored text starts. Measuring bold text as regular shifted
    // every such label left by the difference.
    const measured = measureText(text, {
      size: fontSize,
      family: style.family ?? DEFAULT_TEXT_FAMILY,
      ...(style.bold === undefined ? {} : { bold: style.bold }),
      ...(style.italic === undefined ? {} : { italic: style.italic })
    });
    const textWidth = measured > 0 ? measured : Math.max(1, fontSize * 0.5) * text.length;
    const startX = anchor === "middle" ? x - textWidth / 2 : anchor === "end" ? x - textWidth : x;

    // Try system font rasterization first (high quality filled glyphs)
    const font = loadSystemFont();
    if (font) {
      this.drawTextWithFont(font, startX, y, text, fontSize, textWidth, color, rotation);
      return;
    }

    // Fallback: stroke font
    this.drawTextStroke(startX, y, text, fontSize, textWidth, color, rotation);
  }

  private drawTextWithFont(
    font: RasterFont,
    startX: number,
    y: number,
    text: string,
    fontSize: number,
    textWidth: number,
    color: string | undefined,
    rotation?: { angle: number; originX: number; originY: number }
  ): void {
    const rgba = parseSvgColor(color);
    if (!rgba) {
      return;
    }

    const scale = fontSize / font.unitsPerEm;

    // Compute total advance from font metrics, then scale to match measured width.
    // Iterate by code point (not UTF-16 code unit) so surrogate pairs for
    // non-BMP characters resolve to a single glyph lookup.
    let totalAdvance = 0;
    for (const ch of text) {
      const outline = font.getOutline(ch.codePointAt(0)!);
      totalAdvance += outline ? outline.advanceWidth * scale : fontSize * 0.4;
    }
    const hScale = totalAdvance > 0 ? textWidth / totalAdvance : 1;

    const theta = rotation && rotation.angle !== 0 ? (rotation.angle * Math.PI) / 180 : 0;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ox = rotation ? rotation.originX : 0;
    const oy = rotation ? rotation.originY : 0;

    let curX = startX;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const outline = font.getOutline(code);
      if (!outline) {
        curX += fontSize * 0.4 * hScale;
        continue;
      }

      const glyph = cachedRasterizeGlyph(outline, fontSize, font.unitsPerEm);
      if (glyph.pixels.length === 0) {
        curX += outline.advanceWidth * scale * hScale;
        continue;
      }

      // Position: baseline is at y; glyph offsetY is relative to baseline
      const baseX = curX + glyph.offsetX;
      const baseY = y + glyph.offsetY;

      for (let row = 0; row < glyph.height; row++) {
        for (let col = 0; col < glyph.width; col++) {
          const coverage = glyph.pixels[row * glyph.width + col];
          if (coverage > 0) {
            let px = baseX + col;
            let py = baseY + row;
            if (theta !== 0) {
              const dx = px - ox;
              const dy = py - oy;
              px = ox + dx * cos - dy * sin;
              py = oy + dx * sin + dy * cos;
            }
            // Anti-aliasing coverage *modulates* the paint alpha; it must not
            // replace it. Using coverage alone made every glyph fully opaque at
            // its centre, so `opacity` / `fill-opacity` / an 8-digit hex alpha
            // on text was silently ignored while shapes honoured it.
            const aa: [number, number, number, number] = [
              rgba[0],
              rgba[1],
              rgba[2],
              Math.round((coverage * rgba[3]) / 255)
            ];
            this.setPixel(Math.round(px), Math.round(py), aa);
          }
        }
      }
      curX += outline.advanceWidth * scale * hScale;
    }
  }

  private drawTextStroke(
    startX: number,
    y: number,
    text: string,
    fontSize: number,
    textWidth: number,
    color: string | undefined,
    rotation?: { angle: number; originX: number; originY: number }
  ): void {
    const strokeWidth = Math.max(1, fontSize * 0.08);
    let totalGlyphW = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
      totalGlyphW += glyph ? glyph.w : 0.4;
    }
    const scale = totalGlyphW > 0 ? textWidth / (totalGlyphW * fontSize) : 1;

    if (!rotation || rotation.angle === 0) {
      let cx = startX;
      for (const ch of text) {
        const code = ch.codePointAt(0)!;
        const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
        if (glyph) {
          for (const stroke of glyph.d) {
            for (let j = 1; j < stroke.length; j++) {
              const x1 = cx + stroke[j - 1][0] * fontSize * scale;
              const y1 = y - fontSize * 0.75 + stroke[j - 1][1] * fontSize;
              const x2 = cx + stroke[j][0] * fontSize * scale;
              const y2 = y - fontSize * 0.75 + stroke[j][1] * fontSize;
              this.drawLine(x1, y1, x2, y2, color, strokeWidth);
            }
          }
          cx += glyph.w * fontSize * scale;
        }
      }
      return;
    }
    const theta = (rotation.angle * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ox = rotation.originX;
    const oy = rotation.originY;
    const rotate = (px: number, py: number): [number, number] => {
      const dx = px - ox;
      const dy = py - oy;
      return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos];
    };
    let cx = startX;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const glyph = STROKE_FONT[code] ?? STROKE_FONT[63];
      if (glyph) {
        for (const stroke of glyph.d) {
          for (let j = 1; j < stroke.length; j++) {
            const px1 = cx + stroke[j - 1][0] * fontSize * scale;
            const py1 = y - fontSize * 0.75 + stroke[j - 1][1] * fontSize;
            const px2 = cx + stroke[j][0] * fontSize * scale;
            const py2 = y - fontSize * 0.75 + stroke[j][1] * fontSize;
            const [rx1, ry1] = rotate(px1, py1);
            const [rx2, ry2] = rotate(px2, py2);
            this.drawLine(rx1, ry1, rx2, ry2, color, strokeWidth);
          }
        }
        cx += glyph.w * fontSize * scale;
      }
    }
  }

  /** Intersect the current clip with a rectangle. */
  pushClip(x: number, y: number, width: number, height: number): void {
    const next = {
      x0: Math.floor(x),
      y0: Math.floor(y),
      x1: Math.ceil(x + width),
      y1: Math.ceil(y + height)
    };
    const active = this.clips.at(-1);
    this.clips.push(
      active
        ? {
            x0: Math.max(active.x0, next.x0),
            y0: Math.max(active.y0, next.y0),
            x1: Math.min(active.x1, next.x1),
            y1: Math.min(active.y1, next.y1)
          }
        : next
    );
  }

  /** Drop the innermost clip. */
  popClip(): void {
    this.clips.pop();
  }

  /**
   * Draw several overlapping pieces of one shape as a single composite.
   *
   * A thick stroke is built from a quad per segment plus a wedge at each corner, and
   * those pieces overlap. Compositing each of them in turn is correct only while the
   * paint is opaque: a half-transparent polyline came out visibly darker at every
   * joint, and darker again wherever it crossed itself, because those pixels were
   * blended two or three times. Accumulating coverage first and blending once is what
   * a real rasteriser does, and it handles self-intersection for free — which no
   * amount of care in the outline geometry would.
   *
   * The mask is a byte of coverage per pixel, kept for the canvas's lifetime and
   * cleared only over the region the last shape touched.
   */
  private withCoverage(rgba: [number, number, number, number], draw: () => void): void {
    if (rgba[3] <= 0) {
      return;
    }
    this.mask ??= new Uint8Array(this.width * this.height);
    this.maskAlpha = rgba[3];
    this.maskX0 = this.width;
    this.maskY0 = this.height;
    this.maskX1 = 0;
    this.maskY1 = 0;
    const mask = this.mask;
    draw();
    this.mask = undefined;
    const alpha = rgba[3] / 255;
    for (let y = this.maskY0; y < this.maskY1; y++) {
      for (let x = this.maskX0; x < this.maskX1; x++) {
        const index = y * this.width + x;
        const coverage = mask[index];
        if (coverage === 0) {
          continue;
        }
        mask[index] = 0;
        this.setPixel(x, y, [rgba[0], rgba[1], rgba[2], Math.round(coverage * alpha)]);
      }
    }
  }

  private setPixel(x: number, y: number, rgba: [number, number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const clip = this.clips.at(-1);
    if (clip && (x < clip.x0 || y < clip.y0 || x >= clip.x1 || y >= clip.y1)) {
      return;
    }
    if (this.mask) {
      // Accumulating geometric coverage rather than compositing — see
      // `withCoverage`. The pieces are drawn in the pass's own paint, so their alpha
      // is the pass's alpha wherever they cover a pixel fully; dividing it out leaves
      // coverage, which is what has to be unioned. Storing the alpha itself would
      // apply it twice, once here and once when the mask is blended.
      const index = y * this.width + x;
      const coverage =
        this.maskAlpha <= 0 ? 0 : Math.min(255, Math.round((rgba[3] * 255) / this.maskAlpha));
      if (coverage > this.mask[index]) {
        this.mask[index] = coverage;
      }
      this.maskX0 = Math.min(this.maskX0, x);
      this.maskY0 = Math.min(this.maskY0, y);
      this.maskX1 = Math.max(this.maskX1, x + 1);
      this.maskY1 = Math.max(this.maskY1, y + 1);
      return;
    }
    const i = (y * this.width + x) * 4;
    // Non-premultiplied source-over. The destination's own alpha has to weight
    // its contribution and the result has to be divided by the composite alpha,
    // otherwise the output is premultiplied while the PNG it lands in is not —
    // drawing 20%-opaque red onto an empty (transparent) canvas produced
    // rgb(51,0,0) instead of rgb(255,0,0) at 20% alpha, i.e. every translucent
    // shape darkened towards black. Over an opaque destination (the usual case,
    // since charts paint a background first) this reduces to the previous
    // arithmetic, so opaque output is unchanged.
    const sa = rgba[3] / 255;
    if (sa <= 0) {
      return;
    }
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) {
      return;
    }
    const blend = (src: number, dst: number): number =>
      Math.round((src * sa + dst * da * (1 - sa)) / oa);
    this.data[i] = blend(rgba[0], this.data[i]);
    this.data[i + 1] = blend(rgba[1], this.data[i + 1]);
    this.data[i + 2] = blend(rgba[2], this.data[i + 2]);
    this.data[i + 3] = Math.round(oa * 255);
  }
}
