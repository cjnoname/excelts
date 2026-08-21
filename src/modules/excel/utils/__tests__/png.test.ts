import { unzlibSync } from "@archive/compression/compress";
import { encodePng, withPngDpi } from "@excel/utils/png";
import { describe, expect, it } from "vitest";

const decoder = new TextDecoder();

function readU32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
}

/** Walk the chunk stream so tests assert on structure, not byte offsets. */
function readChunks(png: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = readU32be(png, offset);
    chunks.push({
      type: decoder.decode(png.subarray(offset + 4, offset + 8)),
      data: png.subarray(offset + 8, offset + 8 + length)
    });
    offset += 12 + length;
  }
  return chunks;
}

function chunk(png: Uint8Array, type: string): Chunk | undefined {
  return readChunks(png).find(candidate => candidate.type === type);
}

/** Inflate IDAT and drop the per-row filter byte, recovering the RGBA input. */
function decodeIdatPixels(png: Uint8Array, width: number, height: number): Uint8Array {
  const idat = readChunks(png).filter(candidate => candidate.type === "IDAT");
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.data.length, 0));
  let cursor = 0;
  for (const part of idat) {
    joined.set(part.data, cursor);
    cursor += part.data.length;
  }
  const scanlines = unzlibSync(joined);
  const rowBytes = width * 4;
  expect(scanlines.length).toBe((rowBytes + 1) * height);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * (rowBytes + 1);
    // Filter 0 (None) is the only filter this encoder emits.
    expect(scanlines[src]).toBe(0);
    out.set(scanlines.subarray(src + 1, src + 1 + rowBytes), y * rowBytes);
  }
  return out;
}

/** A small gradient with a varying alpha channel, so nothing can be lossy. */
function makeRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i % 256;
    rgba[i * 4 + 1] = (i * 7) % 256;
    rgba[i * 4 + 2] = (i * 13) % 256;
    rgba[i * 4 + 3] = i % 2 === 0 ? 255 : 128;
  }
  return rgba;
}

describe("encodePng", () => {
  it("writes a well-formed PNG with the expected header", () => {
    const png = encodePng(makeRgba(4, 3), 4, 3);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks = readChunks(png);
    expect(chunks[0].type).toBe("IHDR");
    expect(chunks.at(-1)?.type).toBe("IEND");
    expect(chunks.at(-1)?.data.length).toBe(0);

    const ihdr = chunks[0].data;
    expect(readU32be(ihdr, 0)).toBe(4);
    expect(readU32be(ihdr, 4)).toBe(3);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // colour type: truecolour + alpha
    expect(ihdr[10]).toBe(0); // deflate
    expect(ihdr[11]).toBe(0); // filter method 0
    expect(ihdr[12]).toBe(0); // non-interlaced
  });

  it("round-trips the exact pixels, alpha included", () => {
    const rgba = makeRgba(9, 7);
    const png = encodePng(rgba, 9, 7);
    expect(decodeIdatPixels(png, 9, 7)).toEqual(rgba);
  });

  it("actually compresses instead of storing raw blocks", () => {
    // A single flat colour is the easiest case there is; a stored-block encoder
    // would land at or above the raw size, which is the bug this replaced.
    const width = 200;
    const height = 200;
    const rgba = new Uint8Array(width * height * 4).fill(0xff);
    const png = encodePng(rgba, width, height);
    expect(png.length).toBeLessThan(rgba.length / 50);
    expect(decodeIdatPixels(png, width, height)).toEqual(rgba);
  });

  it("omits pHYs unless a dpi is given", () => {
    expect(chunk(encodePng(makeRgba(2, 2), 2, 2), "pHYs")).toBeUndefined();
  });

  it("omits pHYs for a dpi that cannot describe a resolution", () => {
    // `Math.round(NaN)` is NaN, which used to serialise as a zero
    // pixels-per-metre pHYs — invalid rather than merely unhelpful.
    for (const dpi of [0, -96, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chunk(encodePng(makeRgba(2, 2), 2, 2, { dpi }), "pHYs")).toBeUndefined();
    }
  });

  it("writes pHYs in pixels per metre when a dpi is given", () => {
    const phys = chunk(encodePng(makeRgba(2, 2), 2, 2, { dpi: 192 }), "pHYs");
    expect(phys).toBeDefined();
    const perMetre = Math.round(192 / 0.0254);
    expect(readU32be(phys!.data, 0)).toBe(perMetre);
    expect(readU32be(phys!.data, 4)).toBe(perMetre);
    expect(phys!.data[8]).toBe(1); // unit specifier: metre
  });

  it("orders pHYs before IDAT, as the spec requires", () => {
    const types = readChunks(encodePng(makeRgba(2, 2), 2, 2, { dpi: 96 })).map(part => part.type);
    expect(types.indexOf("pHYs")).toBeGreaterThan(types.indexOf("IHDR"));
    expect(types.indexOf("pHYs")).toBeLessThan(types.indexOf("IDAT"));
  });

  it("rejects dimensions that cannot describe an image", () => {
    const rgba = makeRgba(2, 2);
    expect(() => encodePng(rgba, 0, 2)).toThrow(/positive integers/);
    expect(() => encodePng(rgba, 2, -1)).toThrow(/positive integers/);
    expect(() => encodePng(rgba, 2.5, 2)).toThrow(/positive integers/);
  });

  it("rejects a pixel buffer that does not match the dimensions", () => {
    expect(() => encodePng(new Uint8Array(15), 2, 2)).toThrow(/needs 16/);
  });
});

describe("withPngDpi", () => {
  it("adds pHYs to a PNG that has none", () => {
    const base = encodePng(makeRgba(3, 2), 3, 2);
    expect(chunk(base, "pHYs")).toBeUndefined();

    const stamped = withPngDpi(base, 192);
    const phys = chunk(stamped, "pHYs");
    expect(phys).toBeDefined();
    expect(readU32be(phys!.data, 0)).toBe(Math.round(192 / 0.0254));
    expect(phys!.data[8]).toBe(1);
    // Pixels survive untouched.
    expect(decodeIdatPixels(stamped, 3, 2)).toEqual(makeRgba(3, 2));
  });

  it("inserts pHYs before the first IDAT", () => {
    const types = readChunks(withPngDpi(encodePng(makeRgba(2, 2), 2, 2), 96)).map(
      part => part.type
    );
    expect(types.indexOf("pHYs")).toBeGreaterThan(types.indexOf("IHDR"));
    expect(types.indexOf("pHYs")).toBeLessThan(types.indexOf("IDAT"));
  });

  it("replaces an existing pHYs rather than duplicating it", () => {
    const stamped = withPngDpi(encodePng(makeRgba(2, 2), 2, 2, { dpi: 72 }), 300);
    const all = readChunks(stamped).filter(part => part.type === "pHYs");
    expect(all).toHaveLength(1);
    expect(readU32be(all[0].data, 0)).toBe(Math.round(300 / 0.0254));
  });

  it("is a no-op without a usable dpi", () => {
    const base = encodePng(makeRgba(2, 2), 2, 2);
    for (const dpi of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(withPngDpi(base, dpi as number | undefined)).toBe(base);
    }
  });

  it("hands back non-PNG input untouched", () => {
    const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(withPngDpi(notPng, 96)).toBe(notPng);
  });

  it("hands back a truncated stream untouched", () => {
    const truncated = encodePng(makeRgba(2, 2), 2, 2).subarray(0, 20);
    expect(withPngDpi(truncated, 96)).toBe(truncated);
  });
});

describe("withPngDpi robustness", () => {
  it("preserves bytes that follow IEND", () => {
    // Regression: anything after the last complete chunk was silently dropped.
    const base = encodePng(makeRgba(2, 2), 2, 2);
    const withTrailer = new Uint8Array(base.length + 4);
    withTrailer.set(base);
    withTrailer.set([1, 2, 3, 4], base.length);

    const stamped = withPngDpi(withTrailer, 96);
    expect([...stamped.subarray(stamped.length - 4)]).toEqual([1, 2, 3, 4]);
    expect(chunk(stamped, "pHYs")).toBeDefined();
  });

  it("refuses to rewrite a stream with no IEND", () => {
    const base = encodePng(makeRgba(2, 2), 2, 2);
    const iend = readChunks(base).find(part => part.type === "IEND")!;
    const withoutIend = base.subarray(0, base.length - (iend.data.length + 12));
    expect(withPngDpi(withoutIend, 96)).toBe(withoutIend);
  });

  it("refuses to rewrite a stream with no IHDR", () => {
    const base = encodePng(makeRgba(2, 2), 2, 2);
    const ihdrLength = readChunks(base)[0].data.length + 12;
    const headless = new Uint8Array(base.length - ihdrLength);
    headless.set(base.subarray(0, 8));
    headless.set(base.subarray(8 + ihdrLength), 8);
    expect(withPngDpi(headless, 96)).toBe(headless);
  });
});
