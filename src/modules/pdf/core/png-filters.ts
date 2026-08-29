/**
 * PNG filter reconstruction (RFC 2083 §6 / PNG spec 9.2).
 *
 * One implementation, because there is one algorithm. The PDF reader needs it for
 * a `/FlateDecode` stream carrying `/Predictor 10..15`, and the image decoder needs
 * it for an actual `.png` — and each had a transcription, right down to a private
 * copy of `paethPredictor`. A filter reconstructed even slightly differently does
 * not fail loudly: it produces a plausible image with the wrong pixels, and every
 * later scanline inherits the error.
 *
 * @module
 */

/**
 * Reconstruct filtered scanlines in place of their filter bytes.
 *
 * `data` is `rows × (1 + rowBytes)`: each scanline is preceded by its filter type.
 * The result is `rows × rowBytes` with the filters undone. Callers derive
 * `rowBytes` and `bytesPerPixel` differently — a PDF predictor from
 * `/Columns`, `/Colors` and `/BitsPerComponent`, a PNG from `IHDR` — so both are
 * taken as arguments rather than recomputed here.
 *
 * An unknown filter type is copied through unchanged, which is what both callers
 * did: a malformed stream degrades to visible noise rather than throwing.
 */
export function undoPngFilters(
  data: Uint8Array,
  rows: number,
  rowBytes: number,
  bytesPerPixel: number
): Uint8Array {
  const result = new Uint8Array(rows * rowBytes);
  const bpp = Math.max(1, Math.floor(bytesPerPixel));
  let src = 0;

  for (let row = 0; row < rows; row++) {
    const filterType = data[src++];
    const dst = row * rowBytes;
    const prev = row > 0 ? dst - rowBytes : -1;

    for (let i = 0; i < rowBytes; i++) {
      // `?? 0` for a truncated final scanline, which a PDF stream can carry.
      const raw = data[src++] ?? 0;
      const a = i >= bpp ? result[dst + i - bpp] : 0; // left
      const b = prev >= 0 ? result[prev + i] : 0; // above
      const c = prev >= 0 && i >= bpp ? result[prev + i - bpp] : 0; // upper-left

      switch (filterType) {
        case 0: // None
          result[dst + i] = raw;
          break;
        case 1: // Sub
          result[dst + i] = (raw + a) & 0xff;
          break;
        case 2: // Up
          result[dst + i] = (raw + b) & 0xff;
          break;
        case 3: // Average — the spec's floor((a+b)/2); `a` and `b` are bytes, so
          // the shift is the same value without the float round trip.
          result[dst + i] = (raw + ((a + b) >> 1)) & 0xff;
          break;
        case 4: // Paeth
          result[dst + i] = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          result[dst + i] = raw;
          break;
      }
    }
  }

  return result;
}

/** The PNG Paeth predictor: whichever of left, above or upper-left is nearest. */
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}
