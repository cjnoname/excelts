/**
 * A {@link DrawSurface} that emits PDF vector operators.
 *
 * The adapter owns exactly one concern the shared walker deliberately does not:
 * PDF's page space has **+Y upwards**, while the display list is Y-down like SVG
 * and the chart scene. Flipping here, in the one place that knows about it, is
 * what stops the rest of the pipeline from having to care — and a Y flip is a
 * reflection, so it also reverses the sense of a text rotation, which is a bug
 * the older per-backend renderers each had to discover for themselves.
 *
 * Mirrors the arrangement of `chart-surface.ts`: the drawing model is shared, the
 * coordinate convention is adapted at the boundary.
 */

import type { DrawSurface } from "@draw/surface";
import type { DrawClip, DrawPaint, DrawPathCommand, DrawPoint } from "@draw/types";
import { DEFAULT_TEXT_FAMILY, sectorToPath } from "@draw/types";
import type {
  DrawEllipseOptions,
  DrawLineOptions,
  DrawPathOptions,
  DrawRectOptions,
  DrawTextOptions,
  PathOp
} from "@pdf/builder/document-builder";
import type { PdfColor } from "@pdf/types";
import type { Rgba01 } from "@utils/svg-lex";

/**
 * The part of a page this surface actually draws through.
 *
 * Structural rather than `PdfPageBuilder` itself: the concrete builder also carries
 * annotations, form fields and a content stream, none of which a display list has any
 * opinion about, and naming it in a public signature would drag all of them into the
 * published type surface. A `PdfPageBuilder` satisfies this by construction, and so can
 * anything else that can put these six marks down.
 */
export interface PdfDrawPage {
  drawRect(options: DrawRectOptions): unknown;
  drawEllipse(options: DrawEllipseOptions): unknown;
  drawPath(ops: PathOp[], options?: DrawPathOptions): unknown;
  drawLine(options: DrawLineOptions): unknown;
  drawText(text: string, options: DrawTextOptions): unknown;
  /**
   * The content stream, for the one operation with no builder-level spelling: `q … W n`
   * is the only way to scope a clip, so the surface reaches past the builder for it.
   */
  getContentStream(): PdfClipTarget;
}

/** The content-stream operators {@link PdfDrawPage} needs for clipping. */
export interface PdfClipTarget {
  save(): void;
  restore(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
  endPath(): void;
}

/** Where on the page a display list should land. */
export interface DrawSurfaceRect {
  /** Left edge in PDF points. */
  readonly x: number;
  /** **Bottom** edge in PDF points, matching PDF's own convention. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Build a surface that draws onto `page` inside `rect`.
 *
 * @param page - Target page builder.
 * @param rect - Destination box in PDF points.
 * @param scale - Uniform factor applied to the list's coordinates. Pass the
 *   result of fitting the list into `rect`; the caller decides whether to letterbox.
 */
export function createPdfDrawSurface(
  page: PdfDrawPage,
  rect: DrawSurfaceRect,
  scale = 1
): DrawSurface {
  const mapX = (x: number): number => rect.x + x * scale;
  // y=0 is the list's top edge, which sits at the top of the destination box.
  const mapY = (y: number): number => rect.y + rect.height - y * scale;

  const points = (input: readonly DrawPoint[]): DrawPoint[] =>
    input.map(point => ({ x: mapX(point.x), y: mapY(point.y) }));

  /**
   * Whether a paint asks for any mark at all.
   *
   * `PdfPageBuilder` treats "no fill and no stroke" as *its* caller forgetting to
   * choose, and helpfully strokes 1pt black. That is a reasonable default for the
   * builder's own public API and the wrong reading of a display list, where an empty
   * paint means exactly what SVG's `fill="none"` and the rasteriser's silence mean:
   * draw nothing. Without this the two agreed and PDF alone drew a black outline.
   */
  const hasPaint = (paint: DrawPaint): boolean =>
    paint.fill !== undefined || paint.stroke !== undefined;

  return {
    pushClip(clip: DrawClip) {
      // `q` … `W n` … `Q` is the only way to scope a clip in a content stream, so
      // the save/restore pair is what makes popClip work.
      const stream = page.getContentStream();
      stream.save();
      stream.rect(
        mapX(clip.x),
        mapY(clip.y + clip.height),
        clip.width * scale,
        clip.height * scale
      );
      stream.clip();
      stream.endPath();
    },

    popClip() {
      page.getContentStream().restore();
    },

    rect(x, y, width, height, rx, paint) {
      if (!hasPaint(paint)) {
        return;
      }
      if (rx > 0) {
        // `drawRect` has a `borderRadius`, so a rounded rect stays a rect rather
        // than being lowered to a path.
        page.drawRect({
          x: mapX(x),
          y: mapY(y + height),
          width: width * scale,
          height: height * scale,
          borderRadius: rx * scale,
          ...paintToPdf(paint, scale)
        });
        return;
      }
      page.drawRect({
        x: mapX(x),
        y: mapY(y + height),
        width: width * scale,
        height: height * scale,
        ...paintToPdf(paint, scale)
      });
    },

    ellipse(cx, cy, rx, ry, paint) {
      if (!hasPaint(paint)) {
        return;
      }
      page.drawEllipse({
        cx: mapX(cx),
        cy: mapY(cy),
        rx: rx * scale,
        ry: ry * scale,
        ...paintToPdf(paint, scale)
      });
    },

    sector(cx, cy, radius, innerRadius, startAngle, endAngle, paint) {
      // A PDF content stream has no arc operator, so the sector is lowered to cubics —
      // by the shared builder, not a copy of it. The copy that used to live here wound
      // an annulus's two rings the same way, and PDF fills nonzero, so a full doughnut
      // came out solid while SVG and the rasteriser cut its hole.
      if (!hasPaint(paint)) {
        return;
      }
      const commands = sectorToPath(cx, cy, radius, innerRadius, startAngle, endAngle);
      if (commands.length === 0) {
        return;
      }
      page.drawPath(mapCommands(commands, mapX, mapY), paintToPdf(paint, scale));
    },

    polyline(input, closed, paint) {
      if (!hasPaint(paint)) {
        return;
      }
      const mapped = points(input);
      if (mapped.length < 2) {
        return;
      }
      // A two-point open polyline is a line, and `drawLine` is the only primitive
      // that carries a dash pattern.
      if (!closed && mapped.length === 2) {
        const stroke = paint.stroke;
        if (!stroke) {
          return;
        }
        page.drawLine({
          x1: mapped[0].x,
          y1: mapped[0].y,
          x2: mapped[1].x,
          y2: mapped[1].y,
          color: toPdfColor(stroke),
          lineWidth: (paint.strokeWidth ?? 1) * scale,
          ...(paint.lineJoin === undefined ? {} : { lineJoin: paint.lineJoin }),
          ...(paint.lineCap === undefined ? {} : { lineCap: paint.lineCap }),
          ...(paint.dash && paint.dash.length > 0
            ? { dashPattern: paint.dash.map(part => part * scale) }
            : {})
        });
        return;
      }
      const ops = mapped.map((point, index) =>
        index === 0
          ? ({ op: "move", x: point.x, y: point.y } as const)
          : ({ op: "line", x: point.x, y: point.y } as const)
      );
      page.drawPath(closed ? [...ops, { op: "close" }] : ops, {
        ...paintToPdf(paint, scale),
        closePath: closed
      });
    },

    path(commands, paint) {
      if (!hasPaint(paint)) {
        return;
      }
      page.drawPath(mapCommands(commands, mapX, mapY), paintToPdf(paint, scale));
    },

    text(x, y, lines, style, rotate) {
      if (!style.fill) {
        return;
      }
      const colour = toPdfColor(style.fill);
      for (const line of lines) {
        if (line.text === "") {
          continue;
        }
        // Step the baseline along the text's own down axis. In PDF's Y-up space
        // that is `(sin θ, -cos θ)` for the flipped angle below.
        const radians = (-rotate * Math.PI) / 180;
        const baseX = (line.x ?? x) + Math.sin(radians) * line.dy;
        const baseY = y + Math.cos(radians) * line.dy;
        page.drawText(line.text, {
          x: mapX(baseX),
          y: mapY(baseY),
          fontSize: style.size * scale,
          color: colour,
          anchor: style.anchor ?? "start",
          // A Y reflection reverses a rotation's sense.
          ...(rotate === 0 ? {} : { rotation: -rotate }),
          fontFamily: style.family ?? DEFAULT_TEXT_FAMILY,
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {})
        });
      }
    }
  };
}

/** Map path commands through the surface's coordinate transform. */
function mapCommands(
  commands: readonly DrawPathCommand[],
  mapX: (x: number) => number,
  mapY: (y: number) => number
): PathOp[] {
  const ops: PathOp[] = [];
  for (const command of commands) {
    switch (command.op) {
      case "move":
        ops.push({ op: "move", x: mapX(command.x), y: mapY(command.y) });
        break;
      case "line":
        ops.push({ op: "line", x: mapX(command.x), y: mapY(command.y) });
        break;
      case "cubic":
        ops.push({
          op: "curve",
          x1: mapX(command.x1),
          y1: mapY(command.y1),
          x2: mapX(command.x2),
          y2: mapY(command.y2),
          x3: mapX(command.x),
          y3: mapY(command.y)
        });
        break;
      case "close":
        ops.push({ op: "close" });
        break;
    }
  }
  return ops;
}

/** Convert a display-list colour to the PDF builder's form. */
function toPdfColor(colour: Rgba01): PdfColor {
  return colour.a >= 1
    ? { r: colour.r, g: colour.g, b: colour.b }
    : { r: colour.r, g: colour.g, b: colour.b, a: colour.a };
}

/** Common fill/stroke/lineWidth options for the shape primitives. */
function paintToPdf(
  paint: DrawPaint,
  scale: number
): {
  fill?: PdfColor;
  stroke?: PdfColor;
  lineWidth?: number;
  lineJoin?: "miter" | "round" | "bevel";
  lineCap?: "butt" | "round" | "square";
  fillRule?: "nonzero" | "evenodd";
  dashPattern?: number[];
} {
  return {
    ...(paint.fill ? { fill: toPdfColor(paint.fill) } : {}),
    ...(paint.stroke ? { stroke: toPdfColor(paint.stroke) } : {}),
    ...(paint.strokeWidth === undefined ? {} : { lineWidth: paint.strokeWidth * scale }),
    ...(paint.lineJoin === undefined ? {} : { lineJoin: paint.lineJoin }),
    ...(paint.lineCap === undefined ? {} : { lineCap: paint.lineCap }),
    ...(paint.fillRule === undefined ? {} : { fillRule: paint.fillRule }),
    ...(paint.dash && paint.dash.length > 0
      ? { dashPattern: paint.dash.map(part => part * scale) }
      : {})
  };
}
