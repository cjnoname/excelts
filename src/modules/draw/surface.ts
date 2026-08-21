/**
 * The abstract drawing backend.
 *
 * A surface receives **absolute, already-transformed** coordinates in a Y-down
 * user space: {@link renderDrawList} folds every enclosing group transform into
 * the geometry before calling it. That is the whole point of the split — a
 * surface never implements a transform stack, a clip stack or unit resolution,
 * so a new backend is a few dozen lines rather than a parallel renderer.
 *
 * Implementations live next to the thing they draw onto, the same way
 * `pdf/render/chart-surface.ts` adapts a content stream: `draw/svg.ts` builds
 * markup, the Excel raster surface paints pixels, the PDF surface emits vector
 * operators.
 */

import type {
  DrawClip,
  DrawPaint,
  DrawPathCommand,
  DrawPoint,
  DrawTextLine,
  DrawTextStyle
} from "@draw/types";

/** A drawing backend. Every method receives final, absolute user-space values. */
export interface DrawSurface {
  /**
   * Axis-aligned rectangle. `rx` is a corner radius in the same units; a surface
   * that cannot round corners should ignore it rather than fail.
   */
  rect(x: number, y: number, width: number, height: number, rx: number, paint: DrawPaint): void;

  /** Axis-aligned ellipse. */
  ellipse(cx: number, cy: number, rx: number, ry: number, paint: DrawPaint): void;

  /**
   * Circular sector, annular when `innerRadius > 0`. Angles are radians,
   * clockwise from the positive x-axis in this Y-down space.
   */
  sector(
    cx: number,
    cy: number,
    radius: number,
    innerRadius: number,
    startAngle: number,
    endAngle: number,
    paint: DrawPaint
  ): void;

  /** Open or closed polyline. */
  polyline(points: readonly DrawPoint[], closed: boolean, paint: DrawPaint): void;

  /**
   * Path made of move / line / cubic / close. Backends without curve support
   * flatten the cubics themselves — the walker does not pre-flatten, because a
   * vector backend would then lose accuracy for nothing.
   */
  path(commands: readonly DrawPathCommand[], paint: DrawPaint): void;

  /**
   * Restrict subsequent drawing to `clip`, which is already absolute and
   * axis-aligned. Must be balanced by {@link DrawSurface.popClip}.
   *
   * Optional: a surface that cannot clip may omit both methods, and the walker
   * will draw unclipped rather than refuse. That is a visible degradation, not a
   * silent one — the parity test asserts the backends that do implement it agree.
   */
  pushClip?(clip: DrawClip): void;

  /** Undo the most recent {@link DrawSurface.pushClip}. */
  popClip?(): void;

  /**
   * Begin a group whose content references the SVG filter `id`. Must be balanced
   * by {@link DrawSurface.popFilter}.
   *
   * Only the SVG surface implements this; see `DrawNode.group.svgFilterId`.
   */
  pushFilter?(id: string): void;

  /** Undo the most recent {@link DrawSurface.pushFilter}. */
  popFilter?(): void;

  /**
   * One text node with its baseline runs.
   *
   * @param rotate - Clockwise degrees about `(x, y)` in this Y-down space, after
   *   any enclosing transform. A surface that cannot rotate text should draw it
   *   upright rather than skip it.
   */
  text(
    x: number,
    y: number,
    lines: readonly DrawTextLine[],
    style: DrawTextStyle,
    rotate: number
  ): void;
}
