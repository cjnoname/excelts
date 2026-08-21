/**
 * The single display-list walker.
 *
 * Every backend goes through this function. It owns the two things that used to
 * be reimplemented per backend — transform composition and paint scaling — so
 * the surfaces stay flat and cannot disagree with each other about geometry.
 */

import type { DrawSurface } from "@draw/surface";
import type {
  DrawClip,
  DrawList,
  DrawMatrix,
  DrawNode,
  DrawPaint,
  DrawPathCommand,
  DrawPoint
} from "@draw/types";
import {
  IDENTITY,
  KAPPA,
  apply,
  multiply,
  rotationOf,
  sectorToPath,
  uniformScale
} from "@draw/types";

/** Draw a whole list onto a surface. */
export function renderDrawList(list: DrawList, surface: DrawSurface): void {
  for (const node of list.children) {
    renderNode(node, IDENTITY, surface);
  }
}

/** Draw one node, folding `ctm` into its geometry. */
export function renderNode(node: DrawNode, ctm: DrawMatrix, surface: DrawSurface): void {
  switch (node.kind) {
    case "group": {
      const inner = node.transform ? multiply(ctm, node.transform) : ctm;
      // The clip is authored in the group's own coordinate space, so it goes
      // through the *inner* matrix and therefore moves and scales with the group.
      // A producer writing `clip: { x: 0, y: 0, ... }` means "my local box".
      const clip = node.clip ? transformClip(node.clip, inner) : undefined;
      const clipped = clip !== undefined && surface.pushClip !== undefined;
      if (clipped) {
        surface.pushClip!(clip);
      }
      const filtered = node.svgFilterId !== undefined && surface.pushFilter !== undefined;
      if (filtered) {
        surface.pushFilter!(node.svgFilterId!);
      }
      for (const child of node.children) {
        renderNode(child, inner, surface);
      }
      if (filtered) {
        surface.popFilter?.();
      }
      if (clipped) {
        surface.popClip?.();
      }
      return;
    }

    case "rect": {
      // A zero-extent rect draws nothing. SVG says so explicitly — "a value of
      // zero disables rendering of the element" — but a content stream and a
      // scanline rasteriser will happily stroke it into a visible line, so the
      // same display list would come out differently per backend. Drop it here,
      // in the one walker, rather than leaving each surface to decide.
      if (node.width <= 0 || node.height <= 0) {
        return;
      }
      const paint = scalePaint(node.paint, ctm);
      // A rect stays a rect only under an axis-aligned transform. Anything with
      // rotation or shear has to become a polygon, or the corners would end up in
      // the wrong place — silently, which is how this class of bug hides.
      if (isAxisAligned(ctm)) {
        const a = apply(ctm, node.x, node.y);
        const b = apply(ctm, node.x + node.width, node.y + node.height);
        surface.rect(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.abs(b.x - a.x),
          Math.abs(b.y - a.y),
          (node.rx ?? 0) * uniformScale(ctm),
          paint
        );
        return;
      }
      surface.polyline(
        [
          apply(ctm, node.x, node.y),
          apply(ctm, node.x + node.width, node.y),
          apply(ctm, node.x + node.width, node.y + node.height),
          apply(ctm, node.x, node.y + node.height)
        ],
        true,
        paint
      );
      return;
    }

    case "ellipse": {
      // Same rule as a zero-extent rect: no radius, no rendering, on every
      // backend.
      if (node.rx <= 0 || node.ry <= 0) {
        return;
      }
      const paint = scalePaint(node.paint, ctm);
      if (isAxisAligned(ctm)) {
        const centre = apply(ctm, node.cx, node.cy);
        surface.ellipse(
          centre.x,
          centre.y,
          Math.abs(node.rx * ctm.a),
          Math.abs(node.ry * ctm.d),
          paint
        );
        return;
      }
      // Rotated ellipse: lower to a path so the surface never needs a transform.
      surface.path(ellipseToPath(node.cx, node.cy, node.rx, node.ry, ctm), paint);
      return;
    }

    case "sector": {
      const paint = scalePaint(node.paint, ctm);
      // A sector survives a rotation as a sector — the angles just shift — which
      // is why it is worth keeping whole rather than lowering to a path.
      //
      // It does not survive anything else. A reflection reverses the direction the
      // arc is swept, and a non-uniform scale or shear turns a circular sector
      // into an elliptical one; keeping the primitive through either drew a wedge
      // in the wrong quadrant, or a circular arc of the wrong radius ending
      // somewhere the transform never put it. Lower those to a path, which is
      // exact because a cubic is affine-invariant.
      if (!isRotationWithUniformScale(ctm)) {
        surface.path(
          transformCommands(
            sectorToPath(
              node.cx,
              node.cy,
              node.radius,
              node.innerRadius,
              node.startAngle,
              node.endAngle
            ),
            ctm
          ),
          paint
        );
        return;
      }
      const centre = apply(ctm, node.cx, node.cy);
      const factor = uniformScale(ctm);
      const spin = (rotationOf(ctm) * Math.PI) / 180;
      surface.sector(
        centre.x,
        centre.y,
        node.radius * factor,
        node.innerRadius * factor,
        node.startAngle + spin,
        node.endAngle + spin,
        paint
      );
      return;
    }

    case "line": {
      const from = apply(ctm, node.x1, node.y1);
      const to = apply(ctm, node.x2, node.y2);
      surface.polyline([from, to], false, scalePaint(node.paint, ctm));
      return;
    }

    case "polyline": {
      surface.polyline(
        node.points.map(point => apply(ctm, point.x, point.y)),
        node.closed ?? false,
        scalePaint(node.paint, ctm)
      );
      return;
    }

    case "path": {
      surface.path(transformCommands(node.commands, ctm), scalePaint(node.paint, ctm));
      return;
    }

    case "text": {
      const origin = apply(ctm, node.x, node.y);
      const factor = uniformScale(ctm);
      // Text cannot be sheared by any backend here, so the transform contributes
      // a rotation and a size; both are handed over explicitly.
      surface.text(
        origin.x,
        origin.y,
        node.lines.map(line => ({
          text: line.text,
          dy: line.dy * factor,
          ...(line.x === undefined ? {} : { x: apply(ctm, line.x, node.y).x })
        })),
        { ...node.style, size: node.style.size * factor },
        (node.rotate ?? 0) + rotationOf(ctm)
      );
      return;
    }
  }
}

/**
 * Map a clip rectangle through a transform, keeping it axis-aligned.
 *
 * Under a rotation the exact clip is no longer a rectangle; the bounding box is
 * used, which clips less than asked rather than more. Losing content would be the
 * worse failure, and no producer here rotates a clipped group.
 */
function transformClip(clip: DrawClip, ctm: DrawMatrix): DrawClip {
  const corners = [
    apply(ctm, clip.x, clip.y),
    apply(ctm, clip.x + clip.width, clip.y),
    apply(ctm, clip.x + clip.width, clip.y + clip.height),
    apply(ctm, clip.x, clip.y + clip.height)
  ];
  let minX = corners[0].x;
  let maxX = corners[0].x;
  let minY = corners[0].y;
  let maxY = corners[0].y;
  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Whether a transform maps axis-aligned boxes to axis-aligned boxes. */
function isAxisAligned(m: DrawMatrix): boolean {
  return Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
}

/**
 * Whether the transform is a rotation and a uniform scale, with no reflection.
 *
 * That is the one family a `sector` node survives intact. The linear part has to
 * be a positive multiple of a rotation matrix — `[[k·cosθ, -k·sinθ], [k·sinθ,
 * k·cosθ]]` — which means its columns are orthogonal and equal in length, and its
 * determinant is positive. A negative determinant is a reflection, which reverses
 * the sweep; unequal columns are a non-uniform scale, which makes the arc
 * elliptical.
 */
function isRotationWithUniformScale(m: DrawMatrix): boolean {
  const determinant = m.a * m.d - m.b * m.c;
  if (determinant <= 0) {
    return false;
  }
  const columnX = m.a * m.a + m.b * m.b;
  const columnY = m.c * m.c + m.d * m.d;
  // Compare against the scale so the tolerance stays relative.
  const tolerance = 1e-9 * Math.max(1, columnX, columnY);
  return Math.abs(columnX - columnY) < tolerance && Math.abs(m.a * m.c + m.b * m.d) < tolerance;
}

/**
 * Normalise the paint for a surface: dash lengths made an even cycle, lengths
 * scaled into device units.
 *
 * Stroke width and dash lengths are in user units, so they have to follow the
 * transform. Missing this is why a scaled chart used to come out with hairlines.
 *
 * The dash array is doubled when its length is odd, which is what the IR promises
 * and what SVG does. Left to the backends, each had to rediscover the rule: the
 * rasteriser indexed the author's array directly and decided on/off by index
 * parity, so `[2]` — a perfectly ordinary "2 on, 2 off" — stayed at index 0
 * forever and came out a solid line, and `[4, 2, 1]` drew a 7-unit cycle that
 * exists in no specification. Doubling here means no surface has to know.
 */
function scalePaint(paint: DrawPaint, ctm: DrawMatrix): DrawPaint {
  // A zero-width stroke is not a stroke. SVG has always read it that way — a
  // `stroke-width="0"` element paints nothing — but each backend was left to
  // rediscover it and neither did: the rasteriser floored the width at one pixel and
  // PDF's `0 w` asks the device for its *thinnest* line, so both drew an outline the
  // author had switched off. Dropping it here means no surface has to know.
  if (paint.stroke !== undefined && paint.strokeWidth !== undefined && !(paint.strokeWidth > 0)) {
    const { stroke: _stroke, strokeWidth: _strokeWidth, dash: _dash, ...rest } = paint;
    return rest;
  }
  const factor = uniformScale(ctm);
  const dash =
    paint.dash === undefined || paint.dash.length === 0
      ? undefined
      : paint.dash.length % 2 === 0
        ? paint.dash
        : [...paint.dash, ...paint.dash];
  if (factor === 1 && dash === paint.dash) {
    return paint;
  }
  return {
    ...paint,
    ...(paint.strokeWidth === undefined ? {} : { strokeWidth: paint.strokeWidth * factor }),
    ...(dash === undefined ? {} : { dash: dash.map(part => part * factor) })
  };
}

/** Apply a transform to every coordinate in a path. */
function transformCommands(
  commands: readonly DrawPathCommand[],
  ctm: DrawMatrix
): DrawPathCommand[] {
  return commands.map(command => {
    switch (command.op) {
      case "move":
      case "line": {
        const point = apply(ctm, command.x, command.y);
        return { op: command.op, x: point.x, y: point.y };
      }
      case "cubic": {
        const c1 = apply(ctm, command.x1, command.y1);
        const c2 = apply(ctm, command.x2, command.y2);
        const end = apply(ctm, command.x, command.y);
        return {
          op: "cubic",
          x1: c1.x,
          y1: c1.y,
          x2: c2.x,
          y2: c2.y,
          x: end.x,
          y: end.y
        };
      }
      case "close":
        return command;
    }
  });
}

/** Lower an ellipse to four transformed cubics. */
function ellipseToPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  ctm: DrawMatrix
): DrawPathCommand[] {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  const at = (x: number, y: number): DrawPoint => apply(ctm, x, y);
  const start = at(cx + rx, cy);
  const commands: DrawPathCommand[] = [{ op: "move", x: start.x, y: start.y }];
  const quarter = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    ex: number,
    ey: number
  ): void => {
    const c1 = at(c1x, c1y);
    const c2 = at(c2x, c2y);
    const end = at(ex, ey);
    commands.push({ op: "cubic", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
  };
  quarter(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry);
  quarter(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy);
  quarter(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry);
  quarter(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy);
  commands.push({ op: "close" });
  return commands;
}
