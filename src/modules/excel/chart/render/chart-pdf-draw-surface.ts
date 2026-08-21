/**
 * A {@link DrawSurface} that forwards to the chart module's public
 * {@link ChartPdfDrawingSurface}.
 *
 * ## Why an adapter rather than a new signature
 *
 * `drawChartPdf` and `ChartPdfDrawingSurface` are public API: `pdf/excel-bridge`
 * and `pdf/render/chart-surface` both implement the interface, and the workbook
 * exporter drives it. Changing the signature to take a `DrawSurface` would be a
 * breaking change for no user-visible gain, so the shared drawing engine is put
 * *behind* the existing contract instead: the scene is converted once, walked
 * once, and the calls land on whatever surface the caller already has.
 *
 * ## What this file owns
 *
 * The Y flip, and nothing else. The display list is Y-down like SVG and the chart
 * scene; a PDF page is Y-up. Keeping the reflection in one adapter is also what
 * keeps its consequence in one place — a reflection reverses the sense of a
 * rotation, which the old per-backend renderer had to remember separately.
 *
 * Optional capabilities degrade rather than fail: a surface without `drawPath`
 * gets a polyline approximation, one without `drawCircle` gets a rect, and one
 * with neither still receives every rectangle, line and label.
 */

import type { DrawSurface } from "@draw/surface";
import { flattenPath, roundedRectToPath, sectorToPath } from "@draw/types";
import type { DrawPaint, DrawPathCommand, DrawPoint } from "@draw/types";
import type { ChartPdfDrawingSurface, ChartPdfPathOp } from "@excel/chart/render/chart-renderer";
import type { PdfColor } from "@excel/chart/shared/chart-utils";
import type { Rgba01 } from "@utils/svg-lex";

/** Steps used when a sector or ellipse has to be approximated by a polygon. */
const FALLBACK_STEPS = 48;

/** Convert a display-list colour to the chart surface's colour shape. */
function toPdfColor(colour: Rgba01 | undefined): PdfColor | undefined {
  if (!colour) {
    return undefined;
  }
  return colour.a >= 1
    ? { r: colour.r, g: colour.g, b: colour.b }
    : { r: colour.r, g: colour.g, b: colour.b, a: colour.a };
}

/**
 * The options a `drawPath` call carries.
 *
 * Every primitive that lowers to a path — a rounded rect, a sector, a traced polygon,
 * a generic path — needs the same conversion, and writing it at each call site is how
 * they came to differ: the polyline forwarded the dash pattern, the rounded rect and
 * the generic path dropped it, and the sector dropped the stroke width as well. A
 * dashed sector therefore came out solid in a PDF while SVG dashed it.
 */
function pathOptions(
  paint: DrawPaint,
  closePath?: boolean
): {
  fill?: PdfColor;
  stroke?: PdfColor;
  lineWidth?: number;
  dashPattern?: number[];
  closePath?: boolean;
} {
  return {
    ...(paint.fill ? { fill: toPdfColor(paint.fill)! } : {}),
    ...(paint.stroke ? { stroke: toPdfColor(paint.stroke)! } : {}),
    ...(paint.strokeWidth === undefined ? {} : { lineWidth: paint.strokeWidth }),
    ...(paint.dash && paint.dash.length > 0 ? { dashPattern: [...paint.dash] } : {}),
    ...(closePath === undefined ? {} : { closePath })
  };
}

/**
 * The options a `drawRect` / `drawCircle` call carries.
 *
 * Neither carries a dash in {@link ChartPdfDrawingSurface}; a caller that needs one
 * reaches the path form instead.
 */
function shapeOptions(paint: DrawPaint): {
  fill?: PdfColor;
  stroke?: PdfColor;
  lineWidth?: number;
} {
  return {
    ...(paint.fill ? { fill: toPdfColor(paint.fill)! } : {}),
    ...(paint.stroke ? { stroke: toPdfColor(paint.stroke)! } : {}),
    ...(paint.strokeWidth === undefined ? {} : { lineWidth: paint.strokeWidth })
  };
}

/**
 * Build a surface that draws a display list onto `page` at `(x, y)`.
 *
 * @param page - The caller's chart drawing surface.
 * @param x - Left edge in PDF points.
 * @param y - **Bottom** edge in PDF points, matching PDF's own convention.
 * @param height - Height of the destination box; also the list's user-space
 *   height, since chart scenes are rendered 1:1.
 * @param flipY - Whether to convert the list's Y-down space into PDF's Y-up page
 *   space. Pass `false` when the target surface already flips — the ChartEx
 *   renderer wraps its page in such a surface, and flipping twice would put every
 *   mark on the wrong side of the chart.
 */
export function createChartPdfDrawSurface(
  page: ChartPdfDrawingSurface,
  x: number,
  y: number,
  height: number,
  flipY = true
): DrawSurface {
  const mapX = (value: number): number => x + value;
  // With the flip, y=0 is the list's top edge and sits at the top of the
  // destination box; without it, coordinates pass through unchanged.
  const mapY = (value: number): number => (flipY ? y + height - value : y + value);
  const point = (p: DrawPoint): DrawPoint => ({ x: mapX(p.x), y: mapY(p.y) });

  /**
   * Emit a closed or open run of points, preferring a real path.
   *
   * `approximateFillWithBox` controls the no-`drawPath` fallback for a filled
   * shape. `drawLine` cannot express a fill, so without it the fill is simply
   * lost; `drawRect` is mandatory on every surface, so a filled bounding box keeps
   * the magnitude visible. That is a fair stand-in for a polygon that roughly
   * fills its box — a funnel trapezoid, a marker — and a poor one for a sector,
   * whose box covers its neighbours, so the sector fallback opts out.
   */
  const emitPolygon = (
    points: readonly DrawPoint[],
    closed: boolean,
    paint: DrawPaint,
    approximateFillWithBox = false
  ): void => {
    if (points.length < 2) {
      return;
    }
    const mapped = points.map(point);
    if (page.drawPath) {
      const ops: ChartPdfPathOp[] = mapped.map((p, index) =>
        index === 0 ? { op: "move", x: p.x, y: p.y } : { op: "line", x: p.x, y: p.y }
      );
      if (closed) {
        ops.push({ op: "close" });
      }
      page.drawPath(ops, pathOptions(paint, closed));
      return;
    }
    // No path support. Approximate a fill with its bounding box where that is
    // reasonable, then stroke the outline segment by segment.
    if (approximateFillWithBox && closed && paint.fill) {
      const xs = mapped.map(p => p.x);
      const ys = mapped.map(p => p.y);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      page.drawRect({
        x: x0,
        y: y0,
        width: Math.max(...xs) - x0,
        height: Math.max(...ys) - y0,
        fill: toPdfColor(paint.fill)!
      });
    }
    // A fill-only shape is outlined in its own colour — visible, which is what
    // matters, rather than silently absent. Dropping it made pie slices disappear
    // entirely on such a surface.
    const outline = paint.stroke ?? paint.fill;
    if (!outline) {
      return;
    }
    const segments = closed ? [...mapped, mapped[0]] : mapped;
    for (let index = 1; index < segments.length; index++) {
      page.drawLine({
        x1: segments[index - 1].x,
        y1: segments[index - 1].y,
        x2: segments[index].x,
        y2: segments[index].y,
        color: toPdfColor(outline)!,
        ...(paint.strokeWidth === undefined ? {} : { lineWidth: paint.strokeWidth }),
        ...(paint.dash && paint.dash.length > 0 ? { dashPattern: [...paint.dash] } : {})
      });
    }
  };

  return {
    rect(rx0, ry0, width, rectHeight, cornerRadius, paint) {
      // `drawRect` on this surface carries no corner radius, so a rounded rect used
      // to come out square — the old renderer called that the one unavoidable
      // divergence between the backends for the region map's panel. It is only
      // unavoidable without a path: lower the corners to cubics when the surface
      // can take them, which is the same fallback this adapter already uses for
      // sectors and ellipses.
      if (cornerRadius > 0 && page.drawPath) {
        page.drawPath(
          roundedRectToPath(rx0, ry0, width, rectHeight, cornerRadius).map(command =>
            mapCommand(command, mapX, mapY)
          ),
          pathOptions(paint)
        );
        return;
      }
      page.drawRect({
        x: mapX(rx0),
        y: mapY(flipY ? ry0 + rectHeight : ry0),
        width,
        height: rectHeight,
        ...shapeOptions(paint)
      });
    },

    ellipse(cx, cy, rx, ry, paint) {
      if (page.drawCircle && Math.abs(rx - ry) < 1e-9) {
        page.drawCircle({
          cx: mapX(cx),
          cy: mapY(cy),
          r: rx,
          ...shapeOptions(paint)
        });
        return;
      }
      // No `drawCircle`: fall back to the bounding box. `drawRect` is mandatory
      // on every surface and carries both fill and stroke, whereas a traced
      // polygon can only be stroked — which would silently drop the fill of every
      // marker and data point. A square instead of a circle is the lesser loss.
      const a = point({ x: cx - rx, y: cy - ry });
      const b = point({ x: cx + rx, y: cy + ry });
      page.drawRect({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
        ...shapeOptions(paint)
      });
    },

    sector(cx, cy, radius, innerRadius, startAngle, endAngle, paint) {
      if (radius <= 0) {
        return;
      }
      if (page.drawPath) {
        const commands = sectorToPath(cx, cy, radius, innerRadius, startAngle, endAngle);
        page.drawPath(
          commands.map(command => mapCommand(command, mapX, mapY)),
          pathOptions(paint)
        );
        return;
      }
      // Polygon approximation for a surface with no path support.
      const sweep = endAngle - startAngle;
      const outer: DrawPoint[] = [];
      for (let index = 0; index <= FALLBACK_STEPS; index++) {
        const angle = startAngle + (sweep * index) / FALLBACK_STEPS;
        outer.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      }
      if (innerRadius > 0) {
        for (let index = FALLBACK_STEPS; index >= 0; index--) {
          const angle = startAngle + (sweep * index) / FALLBACK_STEPS;
          outer.push({
            x: cx + innerRadius * Math.cos(angle),
            y: cy + innerRadius * Math.sin(angle)
          });
        }
      } else {
        outer.push({ x: cx, y: cy });
      }
      emitPolygon(outer, true, paint);
    },

    polyline(points, closed, paint) {
      // A two-point open run is a line, and `drawLine` is the only primitive that
      // carries a dash pattern on every surface.
      if (!closed && points.length === 2 && !paint.fill) {
        if (!paint.stroke) {
          return;
        }
        const from = point(points[0]);
        const to = point(points[1]);
        page.drawLine({
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          color: toPdfColor(paint.stroke)!,
          ...(paint.strokeWidth === undefined ? {} : { lineWidth: paint.strokeWidth }),
          ...(paint.dash && paint.dash.length > 0 ? { dashPattern: [...paint.dash] } : {})
        });
        return;
      }
      emitPolygon(points, closed, paint, true);
    },

    path(commands, paint) {
      if (page.drawPath) {
        page.drawPath(
          commands.map(command => mapCommand(command, mapX, mapY)),
          pathOptions(paint)
        );
        return;
      }
      // Each subpath separately: one shared point list would draw a connector
      // between two rings of the same feature — a line across the ocean between
      // two islands — and would lose every ring's closing edge.
      for (const subpath of flattenPath(commands)) {
        emitPolygon(subpath.points, subpath.closed, paint, true);
      }
    },

    text(tx, ty, lines, style, rotate) {
      if (!style.fill) {
        return;
      }
      const colour = toPdfColor(style.fill)!;
      for (const line of lines) {
        if (line.text === "") {
          continue;
        }
        // Step the baseline along the text's own down axis. Under the flip that
        // is `(sin θ, -cos θ)` in PDF's Y-up space; without it, plain Y-down.
        const radians = ((flipY ? -rotate : rotate) * Math.PI) / 180;
        const baseX = (line.x ?? tx) + Math.sin(radians) * line.dy;
        const baseY = flipY ? ty + Math.cos(radians) * line.dy : ty + Math.cos(radians) * line.dy;
        page.drawText(line.text, {
          x: mapX(baseX),
          y: mapY(baseY),
          fontSize: style.size,
          color: colour,
          anchor: style.anchor ?? "start",
          // A Y reflection reverses a rotation's sense; without one the angle
          // passes through.
          ...(rotate === 0 ? {} : { rotation: flipY ? -rotate : rotate }),
          ...(style.family === undefined ? {} : { fontFamily: style.family }),
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {})
        });
      }
    }
  };
}

/** Map one command's coordinates into page space. */
function mapCommand(
  command: DrawPathCommand,
  mapX: (value: number) => number,
  mapY: (value: number) => number
): ChartPdfPathOp {
  switch (command.op) {
    case "move":
      return { op: "move", x: mapX(command.x), y: mapY(command.y) };
    case "line":
      return { op: "line", x: mapX(command.x), y: mapY(command.y) };
    case "cubic":
      return {
        op: "curve",
        x1: mapX(command.x1),
        y1: mapY(command.y1),
        x2: mapX(command.x2),
        y2: mapY(command.y2),
        x3: mapX(command.x),
        y3: mapY(command.y)
      };
    case "close":
      return { op: "close" };
  }
}
