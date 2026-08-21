/**
 * Minimal PNG encoder — 8-bit RGBA, filter 0, optional physical resolution.
 *
 * This exists because two callers used to carry a private copy each, and both
 * copies were half-right:
 *
 * - the chart rasteriser wrote a `pHYs` chunk but framed IDAT as *stored*
 *   (uncompressed) deflate blocks, so a chart PNG was roughly its raw pixel
 *   size;
 * - the watermark generator compressed properly but never wrote `pHYs`, so the
 *   DPI it had just computed was lost.
 *
 * Both also hand-rolled zlib framing, Adler-32 and CRC-32 that the archive
 * module already provides — and provides better: `zlibSync` reaches native
 * `zlib.deflateSync` on Node and falls back to the bundled JS deflate in the
 * browser, both synchronously.
 *
 * Placement: this file has no Excel-specific dependency. It lives here because
 * both callers are in `excel/`, which keeps the layering trivial (excel →
 * archive is already allowed). If a second module ever needs it, move it down
 * rather than copying it a third time — that is the mistake this file undoes.
 */

import { zlibSync } from "@archive/compression/compress";
import { crc32 } from "@archive/compression/crc32";
import { concatUint8Arrays, textEncoder } from "@utils/binary";

/** PNG file signature (\x89 P N G \r \n \x1a \n). */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Deflate level used for IDAT. 6 is zlib's default speed/ratio balance. */
const IDAT_DEFLATE_LEVEL = 6;

/** Metres per inch, for the `pHYs` pixels-per-metre conversion. */
const METRES_PER_INCH = 0.0254;

/** Options for {@link encodePng}. */
export interface EncodePngOptions {
  /**
   * Physical resolution in dots per inch, written as a `pHYs` chunk so
   * consumers (Word, Excel, print pipelines) scale the image correctly instead
   * of assuming 96 DPI. Omitted entirely when undefined.
   */
  readonly dpi?: number;
}

/**
 * Encode 8-bit RGBA pixels as a PNG file.
 *
 * @param rgba - Row-major RGBA bytes, exactly `width * height * 4` long.
 * @param width - Image width in pixels; must be a positive integer.
 * @param height - Image height in pixels; must be a positive integer.
 * @param options - Optional `pHYs` resolution.
 */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: EncodePngOptions = {}
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG dimensions must be positive integers, got ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
      `PNG pixel buffer is ${rgba.length} bytes but ${width}x${height} RGBA needs ${expected}`
    );
  }

  const chunks: Uint8Array[] = [
    PNG_SIGNATURE,
    pngChunk(
      "IHDR",
      concatUint8Arrays([
        u32be(width),
        u32be(height),
        // bit depth 8, colour type 6 (truecolour + alpha), deflate, filter
        // method 0, non-interlaced.
        new Uint8Array([8, 6, 0, 0, 0])
      ])
    )
  ];

  // Guard the same way `withPngDpi` does: a NaN or non-positive dpi would
  // otherwise round to NaN and serialise as a zero pixels-per-metre `pHYs`,
  // which is invalid rather than merely unhelpful.
  if (options.dpi !== undefined && Number.isFinite(options.dpi) && options.dpi > 0) {
    const pixelsPerMetre = Math.max(1, Math.round(options.dpi / METRES_PER_INCH));
    chunks.push(
      pngChunk(
        "pHYs",
        // Unit specifier 1 = metre.
        concatUint8Arrays([u32be(pixelsPerMetre), u32be(pixelsPerMetre), new Uint8Array([1])])
      )
    );
  }

  chunks.push(
    pngChunk(
      "IDAT",
      zlibSync(buildScanlines(rgba, width, height), {
        level: IDAT_DEFLATE_LEVEL
      })
    )
  );
  chunks.push(pngChunk("IEND", new Uint8Array(0)));

  return concatUint8Arrays(chunks);
}

/**
 * Prefix every row with its filter byte. Filter 0 (None) keeps this cheap and
 * lets deflate do the work; the adaptive filters would only pay off for
 * photographic content, which nothing here produces.
 */
function buildScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4;
  const strideOut = rowBytes + 1;
  const out = new Uint8Array(strideOut * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * strideOut;
    out[dst] = 0;
    out.set(rgba.subarray(src, src + rowBytes), dst + 1);
  }
  return out;
}

/** Build one PNG chunk: length(4) + type(4) + data + CRC-32(4) over type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = textEncoder.encode(type);
  const crcInput = concatUint8Arrays([typeBytes, data]);
  return concatUint8Arrays([u32be(data.length), typeBytes, data, u32be(crc32(crcInput))]);
}

/** Big-endian unsigned 32-bit. */
function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]);
}

/**
 * Return `png` with a `pHYs` chunk declaring `dpi`, replacing any existing one.
 *
 * Needed because the browser raster path produces its bytes with
 * `canvas.toBlob()`, which has no way to express a physical resolution — so
 * `Chart.toPNG({ dpi })` wrote the resolution on Node and silently dropped it in
 * a browser, and the same call produced images that printed at different sizes
 * per platform. Rewriting the container afterwards is cheap and keeps the pixel
 * data untouched.
 *
 * Returns the input unchanged if it is not a PNG, so a caller need not probe.
 */
export function withPngDpi(png: Uint8Array, dpi: number | undefined): Uint8Array {
  if (dpi === undefined || !Number.isFinite(dpi) || dpi <= 0) {
    return png;
  }
  if (png.length < 8 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    return png;
  }
  const pixelsPerMetre = Math.max(1, Math.round(dpi / METRES_PER_INCH));
  const phys = pngChunk(
    "pHYs",
    concatUint8Arrays([u32be(pixelsPerMetre), u32be(pixelsPerMetre), new Uint8Array([1])])
  );

  // `pHYs` must precede the first IDAT; drop any existing copy so we do not
  // leave two conflicting resolutions in the stream.
  const head: Uint8Array[] = [PNG_SIGNATURE];
  const tail: Uint8Array[] = [];
  let offset = 8;
  let inserted = false;
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 12 <= png.length) {
    const length = readU32be(png, offset);
    const end = offset + 12 + length;
    if (end > png.length) {
      // Truncated stream — hand the original back rather than emit something worse.
      return png;
    }
    const type = String.fromCharCode(
      png[offset + 4],
      png[offset + 5],
      png[offset + 6],
      png[offset + 7]
    );
    if (type === "IHDR") {
      sawIhdr = true;
    } else if (type === "IEND") {
      sawIend = true;
    }
    const chunk = png.subarray(offset, end);
    if (type === "pHYs") {
      offset = end;
      continue;
    }
    if (!inserted && type !== "IHDR") {
      head.push(phys);
      inserted = true;
    }
    (inserted ? tail : head).push(chunk);
    offset = end;
  }
  // A stream without a proper IHDR/IEND pair is not something to rewrite. The
  // earlier version would happily reassemble one, producing a second malformed
  // file instead of leaving the caller's bytes alone.
  if (!sawIhdr || !sawIend) {
    return png;
  }
  // Anything after the final chunk (fewer than 12 bytes, so never a chunk of its
  // own) is preserved verbatim rather than silently truncated.
  const trailer = png.subarray(offset);
  if (!inserted) {
    head.push(phys);
  }
  return concatUint8Arrays([...head, ...tail, trailer]);
}

/** Big-endian unsigned 32-bit read. */
function readU32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}
