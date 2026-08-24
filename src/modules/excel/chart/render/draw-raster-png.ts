/**
 * A display list to a PNG.
 *
 * The rasteriser itself lives in `@draw/raster`: painting a display list into pixels is
 * the drawing engine's job, and it needs nothing but the IR and a font. Wrapping those
 * pixels in a PNG is a different job — it needs DEFLATE, which lives a layer above the
 * engine — so the two are separated at exactly that seam rather than dragging a
 * compression dependency down into Layer 1.
 *
 * This file is the seam, and it is deliberately the whole of it.
 */

import { encodePng } from "@archive/png";
import type { RasterizeOptions } from "@draw/raster/surface";
import { rasterizeToRgba } from "@draw/raster/surface";
import type { DrawList } from "@draw/types";

/** Options for {@link rasterizeDrawList}. */
export interface RasterizePngOptions extends RasterizeOptions {
  /** Physical resolution recorded in the PNG's `pHYs` chunk. */
  readonly dpi?: number;
}

/** Render a display list to a PNG. */
export function rasterizeDrawList(list: DrawList, options: RasterizePngOptions = {}): Uint8Array {
  const image = rasterizeToRgba(list, options);
  return encodePng(
    image.data,
    image.width,
    image.height,
    options.dpi === undefined ? {} : { dpi: options.dpi }
  );
}
