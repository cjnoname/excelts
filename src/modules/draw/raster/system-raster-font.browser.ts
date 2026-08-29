/**
 * Acquire a system font for the rasteriser — browser stub.
 *
 * A browser has no font files to open, so there is nothing to load and the
 * rasteriser falls back to its built-in stroke font exactly as it did before. What
 * this removes is the per-platform path list, which no runtime guard could: a
 * bundler keeps every string a reachable module might use, so
 * `/System/Library/Fonts/Supplemental/Arial.ttf` and its Windows and Linux
 * counterparts shipped in every browser bundle that draws text.
 *
 * @module
 */

import type { RasterFont } from "@draw/raster/glyph-rasterizer";

/** Always `null`: the caller uses its built-in stroke font instead. */
export function loadSystemFont(): RasterFont | null {
  return null;
}
