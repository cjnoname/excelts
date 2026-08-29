/**
 * Acquire a system font for the rasteriser — Node.js.
 *
 * Separate from `glyph-rasterizer.ts` because it is the only part of it that knows
 * about a filesystem. That module parses and rasterises glyphs and is wanted in
 * every environment; the per-platform list of paths to try is wanted in none but
 * this one, and while it sat inside the rasteriser every browser bundle carried
 * `/System/Library/Fonts/Supplemental/Arial.ttf`, `C:\Windows\Fonts\segoeui.ttf`
 * and the rest. A `typeof process` guard cannot remove them — a bundler must keep
 * any string the module might reach — so the split is what makes them droppable,
 * and `system-raster-font.browser.ts` is what replaces it.
 *
 * @module
 */

import type { RasterFont } from "@draw/raster/glyph-rasterizer";
import { parseRasterFont } from "@draw/raster/glyph-rasterizer";
import { fileExistsSync, readFileBytesSync } from "@utils/fs";

let _cachedFont: RasterFont | null = null;
let _fontLoadAttempted = false;

/**
 * Load a system font for text rasterization.
 *
 * Returns null when no font is found. Attempted once: the result, including
 * failure, is cached.
 */
export function loadSystemFont(): RasterFont | null {
  if (_fontLoadAttempted) {
    return _cachedFont;
  }
  _fontLoadAttempted = true;

  try {
    for (const fontPath of getSystemFontPaths()) {
      try {
        if (fileExistsSync(fontPath)) {
          _cachedFont = parseRasterFont(readFileBytesSync(fontPath));
          return _cachedFont;
        }
      } catch {
        continue; // unreadable or not a font we can parse
      }
    }
  } catch {
    // No filesystem available.
  }

  return null;
}

function getSystemFontPaths(): string[] {
  const platform = typeof process !== "undefined" ? process.platform : "";
  const paths: string[] = [];

  if (platform === "darwin") {
    // macOS: prefer Arial, then Helvetica, then SF Pro
    paths.push(
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/Library/Fonts/Arial.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
      "/System/Library/Fonts/SFNSText.ttf",
      "/System/Library/Fonts/SFNS.ttf"
    );
  } else if (platform === "win32") {
    const windir = process.env.WINDIR || process.env.windir || "C:\\Windows";
    paths.push(
      `${windir}\\Fonts\\arial.ttf`,
      `${windir}\\Fonts\\calibri.ttf`,
      `${windir}\\Fonts\\segoeui.ttf`,
      `${windir}\\Fonts\\tahoma.ttf`
    );
  } else {
    // Linux
    paths.push(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
      "/usr/share/fonts/noto/NotoSans-Regular.ttf",
      "/usr/share/fonts/truetype/freefont/FreeSans.ttf"
    );
  }

  return paths;
}
