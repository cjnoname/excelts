/**
 * `draw` — the shared drawing engine.
 *
 * One structured display list, one walker, many backends. Producers (charts,
 * sparklines, diagram engines) build a {@link DrawList}; backends implement
 * {@link DrawSurface}. Nothing passes an SVG string between renderers any more,
 * which is what used to let each backend drift into its own interpretation of the
 * same picture.
 *
 * @example
 * ```ts
 * import { toSvg, type DrawList } from "documonster/draw";
 *
 * const list: DrawList = {
 *   width: 100,
 *   height: 50,
 *   children: [
 *     { kind: "rect", x: 10, y: 10, width: 80, height: 30,
 *       paint: { fill: { r: 0.2, g: 0.4, b: 0.8, a: 1 } } }
 *   ]
 * };
 * const svg = toSvg(list);
 * ```
 *
 * ## Backends
 *
 * Two ship here: {@link toSvg} serialises to markup, and {@link rasterizeToRgba}
 * paints pixels. A PDF page is the third and lives in `documonster/pdf`
 * (`createPdfDrawSurface`), because it draws onto a page builder rather than
 * producing a standalone artefact. Any of them can be driven from the same list —
 * that is the whole point of having one.
 *
 * Pixels rather than a PNG: encoding one needs DEFLATE, which sits a layer above this
 * module. Pair {@link rasterizeToRgba} with any encoder, or use the chart module's
 * `rasterizeDrawList`, which is that pairing and nothing else.
 */

export { cssColour, translucent } from "@draw/colour";
export { POINTS_PER_PIXEL, measureText, wrapText } from "@draw/text";
export type { DrawSurface } from "@draw/surface";
export { renderDrawList, renderNode } from "@draw/render";
export { SvgSurface, toSvg } from "@draw/svg";
export type { ToSvgOptions } from "@draw/svg";
export {
  createRasterSurface,
  downsample,
  normalizeSamples,
  rasterizeToRgba
} from "@draw/raster/surface";
export type { RasterizeOptions, RgbaImage } from "@draw/raster/surface";
export { BasicRasterCanvas } from "@draw/raster/canvas";
/**
 * Reachable from {@link BasicRasterCanvas}'s own signatures — its point lists and the
 * font it rasterises glyphs from. Without the names a consumer can call the methods but
 * cannot declare a variable to hold what they take.
 */
export type { RasterPoint } from "@draw/raster/canvas";
export type { RasterFont } from "@draw/raster/glyph-rasterizer";
export {
  DEFAULT_TEXT_FAMILY,
  IDENTITY,
  apply,
  arcToCubics,
  multiply,
  rotate,
  flattenPath,
  rectNode,
  roundedRectToPath,
  rotationOf,
  scale,
  sectorToPath,
  translate,
  uniformScale
} from "@draw/types";
/**
 * Re-exported because it is reachable from this module's own signatures —
 * `DrawPaint.fill`, `DrawTextStyle.fill` and the return of {@link cssColour} are
 * all `Rgba01`. Without the name a consumer can assign one but cannot declare one,
 * and would have to resort to `ReturnType<typeof cssColour>`.
 */
export type { Rgba01 } from "@utils/svg-lex";
export type {
  DrawBox,
  DrawClip,
  DrawSubpath,
  DrawList,
  DrawMatrix,
  DrawNode,
  DrawPaint,
  DrawPathCommand,
  DrawPoint,
  DrawTextAnchor,
  DrawTextLine,
  DrawTextStyle
} from "@draw/types";
