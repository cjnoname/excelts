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
 */
export function createChartSurface(
  stream: PdfContentStream,
  fontManager: FontManager,
  alphaValues: Set<number>
): PdfChartDrawingSurface {
  const applyAlpha = (color: PdfColor | undefined): void => {
    if (color?.a !== undefined && color.a < 1) {
      alphaValues.add(color.a);
      stream.setGraphicsState(alphaGsName(color.a));
    }
  };

  const paintFillStroke = (options: {
    fill?: PdfColor;
    stroke?: PdfColor;
    lineWidth?: number;
  }): void => {
    const { fill, stroke, lineWidth } = options;
    if (fill) {
      stream.setFillColor(fill);
      applyAlpha(fill);
    }
    if (stroke) {
      stream.setStrokeColor(stroke);
      // When fill applied a sub-1 alpha but stroke is fully opaque (no
      // `a` field or `a >= 1`), we must explicitly restore opaque alpha
      // so the stroke is not drawn with the fill's transparency. The
      // ExtGState set by `applyAlpha(fill)` applies to both fill and
      // stroke operations in PDF; without this reset the stroke leaks
      // the fill's alpha.
      const strokeNeedsAlpha = stroke.a !== undefined && stroke.a < 1;
      const fillAppliedAlpha = fill?.a !== undefined && fill.a < 1;
      if (strokeNeedsAlpha) {
        applyAlpha(stroke);
      } else if (fillAppliedAlpha) {
        // Reset to fully opaque for the stroke
        alphaValues.add(1);
        stream.setGraphicsState(alphaGsName(1));
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
      stream.rect(x, y, width, height);
      paintFillStroke({ fill, stroke, lineWidth });
      stream.restore();
      return this;
    },

    drawLine(options) {
      const { x1, y1, x2, y2, color, lineWidth, dashPattern } = options;
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
      const color = options.color ?? { r: 0, g: 0, b: 0 };
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
      stream.circle(cx, cy, r);
      paintFillStroke({ fill, stroke, lineWidth });
      stream.restore();
      return this;
    },

    drawPath(ops: PdfChartPathOp[], options) {
      stream.save();
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
      if (options?.dashPattern && options.dashPattern.length > 0) {
        stream.setDashPattern(options.dashPattern);
      }
      paintFillStroke({
        fill: options?.fill,
        stroke: options?.stroke,
        lineWidth: options?.lineWidth
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
