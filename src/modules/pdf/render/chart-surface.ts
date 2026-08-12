/**
 * Adapter that exposes a {@link PdfChartDrawingSurface} on top of a raw
 * {@link PdfContentStream}, letting the page-level exporter forward a chart's
 * vector drawing callback into the same stream that renders the spreadsheet
 * cells.
 *
 * Why this exists: the `chartToPdf` helper in `excel-bridge.ts` renders a
 * single chart onto a `PdfDocumentBuilder` page (which natively implements
 * the chart surface). For workbook-level `excelToPdf`, rendering happens via
 * `pdf-exporter.ts` + `PdfContentStream`, which predate the chart surface.
 * The adapter bridges the two worlds so a chart can be drawn at any
 * `(x, y, width, height)` rect on an already-populated page without
 * refactoring the exporter pipeline.
 *
 * All coordinates are PDF points with **bottom-left origin** — matching the
 * convention the chart renderer emits after its internal Y-flip (see
 * `translateScene` in `@excel/chart/render/chart-renderer.ts`).
 */

import type { PdfContentStream } from "@pdf/core/pdf-stream";
import type { FontManager } from "@pdf/font/font-manager";
import { resolvePdfFontName } from "@pdf/font/font-manager";
import { alphaGsName, emitTextBlock } from "@pdf/render/page-renderer";
import { toGrayscale } from "@pdf/render/style-converter";
import type { PdfChartDrawingSurface, PdfChartPathOp, PdfColor } from "@pdf/types";

/**
 * Build a {@link PdfChartDrawingSurface} that forwards to the given content
 * stream. The returned surface is stateful — callers should not mix it with
 * direct stream mutations for the duration of chart rendering.
 *
 * @param stream        Content stream receiving the drawing operators.
 * @param fontManager   Font manager used for text layout and Type3 fallback.
 * @param alphaValues   Shared set that accumulates transparency values for
 *                      later `ExtGState` registration. The surface adds any
 *                      `color.a` values it observes to this set.
 * @param grayscale     When true, every color the chart renderer emits is
 *                      converted to grayscale. Charts bypass the cell style
 *                      pipeline entirely — the chart engine pushes colors
 *                      straight into this surface — so Excel's "Black and
 *                      white" print option has to be applied right here.
 */
export function createChartSurface(
  stream: PdfContentStream,
  fontManager: FontManager,
  alphaValues: Set<number>,
  grayscale = false
): PdfChartDrawingSurface {
  /** Single choke point for every color entering the surface. */
  const mapColor = <T extends PdfColor | undefined>(color: T): T =>
    grayscale && color ? (toGrayscale(color) as T) : color;

  const applyAlpha = (color: PdfColor | undefined): void => {
    if (color?.a !== undefined && color.a < 1) {
      alphaValues.add(color.a);
      stream.setGraphicsState(alphaGsName(color.a));
    }
  };

  /**
   * Fill and/or stroke the path built by `buildPath`.
   *
   * `buildPath` is a closure rather than a pre-built path because a fill and a
   * stroke with *different* opacities cannot share one graphics state: the
   * alpha `ExtGState` sets `/ca` and `/CA` together, and `fillAndStroke()`
   * paints both under whichever was applied last. In that case we paint in two
   * passes and rebuild the path for the second one. (Within a single pass the
   * unused half of the ExtGState is harmless — a fill-only pass never strokes.)
   */
  const paintFillStroke = (
    buildPath: () => void,
    options: {
      fill?: PdfColor;
      stroke?: PdfColor;
      lineWidth?: number;
      dashPattern?: number[];
    }
  ): void => {
    const { lineWidth, dashPattern } = options;
    const fill = mapColor(options.fill);
    const stroke = mapColor(options.stroke);

    const applyDash = () => {
      if (dashPattern && dashPattern.length > 0) {
        stream.setDashPattern(dashPattern);
      }
    };

    if (fill && stroke) {
      const fillAlpha = fill.a ?? 1;
      const strokeAlpha = stroke.a ?? 1;
      if (fillAlpha !== strokeAlpha) {
        stream.save();
        buildPath();
        stream.setFillColor(fill);
        applyAlpha(fill);
        stream.fill();
        stream.restore();

        stream.save();
        buildPath();
        stream.setStrokeColor(stroke);
        applyAlpha(stroke);
        applyDash();
        if (lineWidth !== undefined) {
          stream.setLineWidth(lineWidth);
        }
        stream.stroke();
        stream.restore();
        return;
      }
    }

    buildPath();
    applyDash();
    // Reaching here means either a single operation, or a fill and stroke that
    // share one opacity — so one ExtGState describes both and no reset is
    // needed (the differing case returned above, each pass in its own q/Q).
    if (fill) {
      stream.setFillColor(fill);
      applyAlpha(fill);
    }
    if (stroke) {
      stream.setStrokeColor(stroke);
      if (!fill) {
        applyAlpha(stroke);
      }
      if (lineWidth !== undefined) {
        stream.setLineWidth(lineWidth);
      }
    }
    if (fill && stroke) {
      stream.fillAndStroke();
    } else if (fill) {
      stream.fill();
    } else if (stroke) {
      stream.stroke();
    } else {
      stream.endPath();
    }
  };

  return {
    drawRect(options) {
      const { x, y, width, height, fill, stroke, lineWidth } = options;
      stream.save();
      paintFillStroke(() => stream.rect(x, y, width, height), { fill, stroke, lineWidth });
      stream.restore();
      return this;
    },

    drawLine(options) {
      const { x1, y1, x2, y2, lineWidth, dashPattern } = options;
      const color = mapColor(options.color);
      stream.save();
      if (color) {
        stream.setStrokeColor(color);
        applyAlpha(color);
      }
      if (lineWidth !== undefined) {
        stream.setLineWidth(lineWidth);
      }
      if (dashPattern && dashPattern.length > 0) {
        stream.setDashPattern(dashPattern);
      }
      stream.moveTo(x1, y1).lineTo(x2, y2).stroke();
      stream.restore();
      return this;
    },

    drawText(text, options) {
      if (!text) {
        return this;
      }
      const fontSize = options.fontSize ?? 10;
      const color = mapColor(options.color ?? { r: 0, g: 0, b: 0 });
      const bold = options.bold ?? false;
      const italic = options.italic ?? false;
      const fontFamily = options.fontFamily ?? "Helvetica";
      const anchor = options.anchor ?? "start";
      const rotation = options.rotation ?? 0;

      // Font resources are frozen before page content is written. Track every
      // chart label during the exporter preflight so Unicode glyph subsets and
      // Type1 style variants exist before the resource dictionary is emitted.
      fontManager.trackText(text);

      const resourceName = resolveResourceName(fontManager, fontFamily, bold, italic);

      stream.save();
      stream.setFillColor(color);
      applyAlpha(color);

      emitTextBlock(
        stream,
        {
          text,
          x: options.x,
          y: options.y,
          type1ResourceName: resourceName,
          fontSize,
          anchor,
          lineHeightFactor: 1,
          // Chart surface rotation is clockwise; text blocks use PDF's
          // counter-clockwise convention.
          rotation: -rotation
        },
        fontManager
      );

      stream.restore();
      return this;
    },

    drawCircle(options) {
      const { cx, cy, r, fill, stroke, lineWidth } = options;
      stream.save();
      paintFillStroke(() => stream.circle(cx, cy, r), { fill, stroke, lineWidth });
      stream.restore();
      return this;
    },

    drawPath(ops: PdfChartPathOp[], options) {
      const buildPath = () => {
        for (const op of ops) {
          switch (op.op) {
            case "move":
              stream.moveTo(op.x, op.y);
              break;
            case "line":
              stream.lineTo(op.x, op.y);
              break;
            case "curve":
              stream.curveTo(op.x1, op.y1, op.x2, op.y2, op.x3, op.y3);
              break;
            case "close":
              stream.closePath();
              break;
          }
        }
        if (options?.closePath) {
          stream.closePath();
        }
      };

      stream.save();
      paintFillStroke(buildPath, {
        fill: options?.fill,
        stroke: options?.stroke,
        lineWidth: options?.lineWidth,
        dashPattern: options?.dashPattern
      });
      stream.restore();
      return this;
    }
  };
}

function resolveResourceName(
  fontManager: FontManager,
  fontFamily: string,
  bold: boolean,
  italic: boolean
): string {
  if (fontManager.hasEmbeddedFont()) {
    return fontManager.getEmbeddedResourceName();
  }
  return fontManager.ensureFont(resolvePdfFontName(fontFamily, bold, italic));
}
