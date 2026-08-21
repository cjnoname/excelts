/**
 * SVG output.
 *
 * This is a {@link DrawSurface} like any other — which is the point. SVG used to
 * be the format the renderers passed *between* themselves, so every other backend
 * had to re-parse it and they all disagreed about what the attributes meant. Here
 * it is simply one serialisation of the display list, with no reader on the other
 * end.
 *
 * The markup stays inside the subset the rest of the library already understands
 * (flat elements, presentation attributes, absolute coordinates) so that an SVG
 * produced here can still be handed to `PdfPageBuilder.drawSvg` or the Excel
 * raster fallback if a caller wants to go that way.
 */

import { escapeXmlAttribute, escapeXmlText } from "@draw/escape";
import { renderDrawList } from "@draw/render";
import type { DrawSurface } from "@draw/surface";
import type {
  DrawClip,
  DrawList,
  DrawPaint,
  DrawPathCommand,
  DrawPoint,
  DrawTextLine,
  DrawTextStyle
} from "@draw/types";
import { DEFAULT_TEXT_FAMILY } from "@draw/types";
import type { Rgba01 } from "@utils/svg-lex";

/** Options for {@link toSvg}. */
export interface ToSvgOptions {
  /**
   * Output width and height. Defaults to the list's own size; when different, a
   * `viewBox` is emitted so the content scales rather than being cropped.
   */
  readonly width?: number;
  readonly height?: number;
  /** Background fill. Omitted means transparent. */
  readonly background?: string;
  /**
   * XML comment placed at the top of the document, before any drawing.
   *
   * Used to carry a provenance note into the output — the chart preview states
   * that it is deterministic rather than Excel-identical, which is a promise worth
   * keeping visible in the artefact itself.
   */
  readonly comment?: string;
}

/** Serialise a display list to an SVG document. */
export function toSvg(list: DrawList, options: ToSvgOptions = {}): string {
  const surface = new SvgSurface();
  if (list.svgDefs && list.svgDefs.length > 0) {
    surface.addDefs(list.svgDefs);
  }
  renderDrawList(list, surface);
  const width = options.width ?? list.width;
  const height = options.height ?? list.height;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}"` +
      ` viewBox="0 0 ${num(list.width)} ${num(list.height)}">`
  ];
  if (options.comment !== undefined) {
    // `--` cannot appear inside an XML comment; collapse any run of dashes.
    parts.push(`<!-- ${options.comment.replace(/-{2,}/g, "-")} -->`);
  }
  if (options.background !== undefined) {
    parts.push(
      `<rect x="0" y="0" width="${num(list.width)}" height="${num(list.height)}" fill="${escapeXmlAttribute(options.background)}"/>`
    );
  }
  parts.push(surface.markup());
  parts.push("</svg>");
  return parts.join("");
}

/** A {@link DrawSurface} that accumulates SVG elements. */
export class SvgSurface implements DrawSurface {
  private readonly parts: string[] = [];
  private readonly defs: string[] = [];
  private clipDepth = 0;
  private filterDepth = 0;

  /** The accumulated elements, without a wrapping `<svg>`. */
  markup(): string {
    // Close any group the producer left open rather than emit invalid markup.
    const trailing = "</g>".repeat(this.clipDepth + this.filterDepth);
    const defs = this.defs.length > 0 ? `<defs>${this.defs.join("")}</defs>` : "";
    return defs + this.parts.join("") + trailing;
  }

  pushClip(clip: DrawClip): void {
    const id = `dc${this.defs.length}`;
    this.defs.push(
      `<clipPath id="${id}"><rect x="${num(clip.x)}" y="${num(clip.y)}"` +
        ` width="${num(clip.width)}" height="${num(clip.height)}"/></clipPath>`
    );
    this.parts.push(`<g clip-path="url(#${id})">`);
    this.clipDepth++;
  }

  popClip(): void {
    if (this.clipDepth > 0) {
      this.parts.push("</g>");
      this.clipDepth--;
    }
  }

  pushFilter(id: string): void {
    this.parts.push(`<g filter="url(#${escapeXmlAttribute(id)})">`);
    this.filterDepth++;
  }

  popFilter(): void {
    if (this.filterDepth > 0) {
      this.parts.push("</g>");
      this.filterDepth--;
    }
  }

  /** Add raw `<defs>` content, e.g. filter definitions. */
  addDefs(markup: readonly string[]): void {
    this.defs.push(...markup);
  }

  rect(x: number, y: number, width: number, height: number, rx: number, paint: DrawPaint): void {
    if (width <= 0 || height <= 0) {
      return;
    }
    this.parts.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"` +
        (rx > 0 ? ` rx="${num(rx)}"` : "") +
        paintAttrs(paint) +
        "/>"
    );
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, paint: DrawPaint): void {
    if (rx <= 0 || ry <= 0) {
      return;
    }
    // A circle is emitted as `<circle>` because the Excel raster fallback
    // recognises that element but not `<ellipse>`, and staying inside the shared
    // subset keeps this output usable by every consumer in the library.
    this.parts.push(
      rx === ry
        ? `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(rx)}"${paintAttrs(paint)}/>`
        : `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(rx)}" ry="${num(ry)}"${paintAttrs(paint)}/>`
    );
  }

  sector(
    cx: number,
    cy: number,
    radius: number,
    innerRadius: number,
    startAngle: number,
    endAngle: number,
    paint: DrawPaint
  ): void {
    if (radius <= 0) {
      return;
    }
    const sweepRaw = endAngle - startAngle;
    const sweep = Math.abs(sweepRaw);
    // A single `A` cannot describe a full circle: its start and end points would
    // coincide and the arc collapses to nothing.
    if (sweep >= Math.PI * 2 - 1e-9) {
      if (innerRadius > 0) {
        const arc = (r: number, flag: number): string =>
          `A ${num(r)} ${num(r)} 0 1 ${flag} ${num(cx + r)} ${num(cy)} ` +
          `A ${num(r)} ${num(r)} 0 1 ${flag} ${num(cx - r)} ${num(cy)}`;
        this.parts.push(
          `<path d="M ${num(cx - radius)} ${num(cy)} ${arc(radius, 1)} ` +
            `M ${num(cx - innerRadius)} ${num(cy)} ${arc(innerRadius, 0)} Z"` +
            paintAttrs({ ...paint, fillRule: "evenodd" }) +
            "/>"
        );
        return;
      }
      this.parts.push(
        `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(radius)}"${paintAttrs(paint)}/>`
      );
      return;
    }
    const large = sweep > Math.PI ? 1 : 0;
    const flag = sweepRaw >= 0 ? 1 : 0;
    const at = (angle: number, r: number): DrawPoint => ({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r
    });
    const outerFrom = at(startAngle, radius);
    const outerTo = at(endAngle, radius);
    if (innerRadius > 0) {
      const innerTo = at(endAngle, innerRadius);
      const innerFrom = at(startAngle, innerRadius);
      this.parts.push(
        `<path d="M ${num(outerFrom.x)} ${num(outerFrom.y)} ` +
          `A ${num(radius)} ${num(radius)} 0 ${large} ${flag} ${num(outerTo.x)} ${num(outerTo.y)} ` +
          `L ${num(innerTo.x)} ${num(innerTo.y)} ` +
          `A ${num(innerRadius)} ${num(innerRadius)} 0 ${large} ${flag === 1 ? 0 : 1} ${num(innerFrom.x)} ${num(innerFrom.y)} Z"` +
          paintAttrs(paint) +
          "/>"
      );
      return;
    }
    this.parts.push(
      `<path d="M ${num(cx)} ${num(cy)} L ${num(outerFrom.x)} ${num(outerFrom.y)} ` +
        `A ${num(radius)} ${num(radius)} 0 ${large} ${flag} ${num(outerTo.x)} ${num(outerTo.y)} Z"` +
        paintAttrs(paint) +
        "/>"
    );
  }

  polyline(points: readonly DrawPoint[], closed: boolean, paint: DrawPaint): void {
    if (points.length < 2) {
      return;
    }
    const list = points.map(point => `${num(point.x)},${num(point.y)}`).join(" ");
    this.parts.push(
      `<${closed ? "polygon" : "polyline"} points="${list}"${paintAttrs(paint, !closed)}/>`
    );
  }

  path(commands: readonly DrawPathCommand[], paint: DrawPaint): void {
    if (commands.length === 0) {
      return;
    }
    const d = commands
      .map(command => {
        switch (command.op) {
          case "move":
            return `M ${num(command.x)} ${num(command.y)}`;
          case "line":
            return `L ${num(command.x)} ${num(command.y)}`;
          case "cubic":
            return (
              `C ${num(command.x1)} ${num(command.y1)} ${num(command.x2)} ${num(command.y2)}` +
              ` ${num(command.x)} ${num(command.y)}`
            );
          case "close":
            return "Z";
        }
      })
      .join(" ");
    this.parts.push(`<path d="${d}"${paintAttrs(paint)}/>`);
  }

  text(
    x: number,
    y: number,
    lines: readonly DrawTextLine[],
    style: DrawTextStyle,
    rotate: number
  ): void {
    const visible = lines.filter(line => line.text !== "");
    if (visible.length === 0 || !style.fill) {
      return;
    }
    const attrs =
      ` font-size="${num(style.size)}"` +
      ` fill="${colour(style.fill)}"` +
      (style.fill.a < 1 ? ` fill-opacity="${num(style.fill.a)}"` : "") +
      ` text-anchor="${style.anchor ?? "start"}"` +
      // Always written, and always the face the text was measured in: omitting it left the
      // viewer to pick, so a centred label measured as one font was placed for another.
      ` font-family="${escapeXmlAttribute(style.family ?? DEFAULT_TEXT_FAMILY)}"` +
      (style.bold ? ` font-weight="bold"` : "") +
      (style.italic ? ` font-style="italic"` : "") +
      (rotate === 0 ? "" : ` transform="rotate(${num(rotate)} ${num(x)} ${num(y)})"`);

    if (visible.length === 1 && visible[0].dy === 0 && visible[0].x === undefined) {
      this.parts.push(
        `<text x="${num(x)}" y="${num(y)}"${attrs}>${escapeXmlText(visible[0].text)}</text>`
      );
      return;
    }
    // Multiple baselines become tspans with absolute positions rather than
    // relative `dy`, so no consumer has to resolve units to place them.
    const tspans = visible
      .map(
        line =>
          `<tspan x="${num(line.x ?? x)}" y="${num(y + line.dy)}">${escapeXmlText(line.text)}</tspan>`
      )
      .join("");
    this.parts.push(`<text x="${num(x)}" y="${num(y)}"${attrs}>${tspans}</text>`);
  }
}

/** Format a number compactly without exponent notation. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** `#rrggbb` for a colour's channels. */
function colour(value: Rgba01): string {
  const channel = (component: number): string =>
    Math.max(0, Math.min(255, Math.round(component * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`;
}

/**
 * Serialise a paint as presentation attributes.
 *
 * @param openPath - When true the shape has no interior to fill (an open
 *   polyline), so an explicit `fill="none"` is written. SVG's initial fill is
 *   black, and omitting this is why unfilled polylines used to come out solid.
 */
function paintAttrs(paint: DrawPaint, openPath = false): string {
  const out: string[] = [];
  if (paint.fill && !openPath) {
    out.push(` fill="${colour(paint.fill)}"`);
    if (paint.fill.a < 1) {
      out.push(` fill-opacity="${num(paint.fill.a)}"`);
    }
  } else {
    out.push(` fill="none"`);
  }
  if (paint.stroke) {
    out.push(` stroke="${colour(paint.stroke)}"`);
    if (paint.stroke.a < 1) {
      out.push(` stroke-opacity="${num(paint.stroke.a)}"`);
    }
    if (paint.strokeWidth !== undefined && paint.strokeWidth !== 1) {
      out.push(` stroke-width="${num(paint.strokeWidth)}"`);
    }
    if (paint.dash && paint.dash.length > 0) {
      out.push(` stroke-dasharray="${paint.dash.map(num).join(" ")}"`);
    }
    if (paint.lineJoin !== undefined && paint.lineJoin !== "miter") {
      out.push(` stroke-linejoin="${paint.lineJoin}"`);
    }
    if (paint.lineCap !== undefined && paint.lineCap !== "butt") {
      out.push(` stroke-linecap="${paint.lineCap}"`);
    }
  }
  if (paint.fillRule === "evenodd") {
    out.push(` fill-rule="evenodd"`);
  }
  return out.join("");
}
