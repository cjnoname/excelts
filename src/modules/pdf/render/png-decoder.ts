/**
 * Minimal PNG decoder for PDF image embedding.
 *
 * Extracts raw RGB pixel data from a PNG file. Handles:
 * - Color types: RGB (2), RGBA (6), Grayscale (0), Grayscale+Alpha (4), Palette (3)
 * - Bit depth: 8 (most common)
 * - Interlacing: non-interlaced only (Adam7 interlacing is not supported)
 * - All 5 PNG filter types (None, Sub, Up, Average, Paeth)
 *
 * For RGBA images, produces separate RGB pixels and an alpha mask (for PDF SMask).
 */

import { decompressSync } from "@archive/compression/compress";
import { undoPngFilters } from "@pdf/core/png-filters";
import { concatUint8Arrays } from "@utils/binary";

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum allowed pixel count for PNG decoding (default: 100 million pixels).
 * A 10000x10000 RGBA image at 100M pixels would need ~400MB for raw data alone.
 * This limit prevents memory exhaustion from malicious PNG files with
 * excessively large declared dimensions.
 */
const MAX_PNG_PIXELS = 100_000_000;

// =============================================================================
// Types
// =============================================================================

export interface DecodedPng {
  width: number;
  height: number;
  /** Raw RGB pixel data (3 bytes per pixel, row-major) */
  pixels: Uint8Array;
  /** Alpha channel (1 byte per pixel) — null if image is fully opaque */
  alpha: Uint8Array | null;
  /** Bits per component (always 8 after decoding) */
  bitsPerComponent: number;
}

// =============================================================================
// PNG Decoder
// =============================================================================

/**
 * Decode a PNG file to raw RGB pixels for PDF embedding.
 * @throws on invalid or unsupported PNG data
 */
export function decodePng(data: Uint8Array): DecodedPng {
  // Verify PNG signature
  if (
    data.length < 8 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47
  ) {
    throw new Error("Invalid PNG signature");
  }

  // Parse chunks
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;

  while (offset + 8 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunkLen = view.getUint32(offset, false);
    const chunkType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );
    const chunkData = data.subarray(offset + 8, offset + 8 + chunkLen);
    offset += 8 + chunkLen + 4; // +4 for CRC

    switch (chunkType) {
      case "IHDR": {
        const hdr = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
        width = hdr.getUint32(0, false);
        height = hdr.getUint32(4, false);
        bitDepth = chunkData[8];
        colorType = chunkData[9];
        // chunkData[10] = compression (always 0)
        // chunkData[11] = filter (always 0)
        // chunkData[12] = interlace (0 = none, 1 = Adam7)
        if (chunkData[12] !== 0) {
          throw new Error("Interlaced PNG is not supported");
        }
        if (bitDepth !== 8) {
          throw new Error(`Unsupported PNG bit depth: ${bitDepth}. Only 8-bit PNGs are supported.`);
        }
        // Guard against malicious dimensions that would cause memory exhaustion
        if (width === 0 || height === 0) {
          throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
        }
        const totalPixels = width * height;
        if (totalPixels > MAX_PNG_PIXELS) {
          throw new Error(
            `PNG dimensions too large: ${width}x${height} (${totalPixels} pixels). ` +
              `Maximum allowed: ${MAX_PNG_PIXELS} pixels.`
          );
        }
        break;
      }
      case "PLTE":
        palette = new Uint8Array(chunkData);
        break;
      case "tRNS":
        trns = new Uint8Array(chunkData);
        break;
      case "IDAT":
        idatChunks.push(chunkData);
        break;
      case "IEND":
        break;
    }
  }

  if (width === 0 || height === 0) {
    throw new Error("PNG missing IHDR chunk");
  }

  // Concatenate and decompress IDAT chunks
  const compressedData = concatUint8Arrays(idatChunks);

  // IDAT data is zlib-wrapped deflate (2 byte header + deflate + 4 byte checksum)
  // Strip the zlib header (2 bytes) and checksum (4 bytes)
  let rawCompressed: Uint8Array;
  if (compressedData.length > 6 && (compressedData[0] & 0x0f) === 8) {
    // Zlib wrapper detected — strip header (2 bytes) and Adler-32 checksum (4 bytes)
    rawCompressed = compressedData.subarray(2, compressedData.length - 4);
  } else {
    rawCompressed = compressedData;
  }
  const rawData = decompressSync(rawCompressed);

  // Determine bytes per pixel and channels
  const channels = getChannelCount(colorType);
  const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8);
  const scanlineLen = Math.ceil((width * channels * bitDepth) / 8);

  // Apply PNG filters to reconstruct raw pixel data
  const unfiltered = applyFilters(rawData, width, height, scanlineLen, bytesPerPixel);

  // Convert to RGB + optional alpha
  return toRgb(unfiltered, width, height, colorType, bitDepth, palette, trns);
}

// =============================================================================
// PNG Filter Reconstruction
// =============================================================================

function applyFilters(
  data: Uint8Array,
  _width: number,
  height: number,
  scanlineLen: number,
  bytesPerPixel: number
): Uint8Array {
  return undoPngFilters(data, height, scanlineLen, bytesPerPixel);
}

// =============================================================================
// Color Type Conversion
// =============================================================================

function getChannelCount(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // Grayscale
    case 2:
      return 3; // RGB
    case 3:
      return 1; // Palette index
    case 4:
      return 2; // Grayscale + Alpha
    case 6:
      return 4; // RGBA
    default:
      return 3;
  }
}

function toRgb(
  data: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  _bitDepth: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null
): DecodedPng {
  const totalPixels = width * height;
  const pixels = new Uint8Array(totalPixels * 3);
  let alpha: Uint8Array | null = null;

  switch (colorType) {
    case 2: {
      // RGB — direct copy, with optional tRNS single-color transparency
      pixels.set(data.subarray(0, totalPixels * 3));
      if (trns && trns.length >= 6) {
        // tRNS for truecolor: 2 bytes each for R, G, B (16-bit values, use high byte for 8-bit)
        const trR = trns[1]; // low byte of 16-bit value = 8-bit sample
        const trG = trns[3];
        const trB = trns[5];
        alpha = new Uint8Array(totalPixels);
        alpha.fill(255);
        for (let i = 0; i < totalPixels; i++) {
          if (data[i * 3] === trR && data[i * 3 + 1] === trG && data[i * 3 + 2] === trB) {
            alpha[i] = 0;
          }
        }
      }
      break;
    }
    case 6: {
      // RGBA — split into RGB + alpha
      alpha = new Uint8Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        pixels[i * 3] = data[i * 4];
        pixels[i * 3 + 1] = data[i * 4 + 1];
        pixels[i * 3 + 2] = data[i * 4 + 2];
        alpha[i] = data[i * 4 + 3];
      }
      break;
    }
    case 0: {
      // Grayscale → RGB, with optional tRNS single-value transparency
      let trGray = -1;
      if (trns && trns.length >= 2) {
        trGray = trns[1]; // low byte of 16-bit value = 8-bit sample
      }
      if (trGray >= 0) {
        alpha = new Uint8Array(totalPixels);
        alpha.fill(255);
      }
      for (let i = 0; i < totalPixels; i++) {
        const g = data[i];
        pixels[i * 3] = g;
        pixels[i * 3 + 1] = g;
        pixels[i * 3 + 2] = g;
        if (alpha && g === trGray) {
          alpha[i] = 0;
        }
      }
      break;
    }
    case 4: {
      // Grayscale + Alpha
      alpha = new Uint8Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        const g = data[i * 2];
        pixels[i * 3] = g;
        pixels[i * 3 + 1] = g;
        pixels[i * 3 + 2] = g;
        alpha[i] = data[i * 2 + 1];
      }
      break;
    }
    case 3: {
      // Palette — lookup from PLTE chunk
      if (!palette) {
        throw new Error("PNG palette color type (3) but missing PLTE chunk");
      }
      const hasAlpha = trns && trns.length > 0;
      if (hasAlpha) {
        alpha = new Uint8Array(totalPixels);
      }
      for (let i = 0; i < totalPixels; i++) {
        const idx = data[i];
        pixels[i * 3] = palette[idx * 3] ?? 0;
        pixels[i * 3 + 1] = palette[idx * 3 + 1] ?? 0;
        pixels[i * 3 + 2] = palette[idx * 3 + 2] ?? 0;
        if (alpha) {
          alpha[i] = idx < trns!.length ? trns![idx] : 255;
        }
      }
      break;
    }
    default:
      throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  // Check if alpha is fully opaque (all 255) — if so, discard it
  if (alpha) {
    let fullyOpaque = true;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] !== 255) {
        fullyOpaque = false;
        break;
      }
    }
    if (fullyOpaque) {
      alpha = null;
    }
  }

  return { width, height, pixels, alpha, bitsPerComponent: 8 };
}
